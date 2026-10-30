import CryptoKit
import Foundation

/// What this phone needs to send commands to one patient's Loop (loop-support-plan.md, stage 3). Kept only in this
/// phone's Keychain, like Trio's: never sent to the server, not synced, not readable while the phone is locked.
public struct LoopRemoteSettings: Codable, Equatable, Sendable {
    /// The URL of the QR code in Loop (Ustawienia → Nightscout → zdalne polecenia): the one-time password secret.
    public var otpURL: String
    /// The APNs key (.p8) of the Apple team that built Loop.
    public var apnsKeyID: String
    public var apnsKeyP8: String
    /// That team, when Nightscout cannot tell it (a bundle id other than LoopWorkspace's `com.<TEAM>.loopkit.Loop`).
    public var teamID: String?
    /// A key of GlucoMind's team for Loop's answer, only when Loop is built by another team; nil means the same key.
    public var returnKeyID: String?
    public var returnKeyP8: String?
    /// Limits checked on this phone before anything is sent; never looser than Loop's own.
    public var maxBolusUnits: Decimal
    public var maxCarbsGrams: Int
    public var bolusIncrement: Decimal
    /// The Loop the caregiver confirmed as this patient's.
    public var pinnedLoop: PinnedLoop?
    public var limitsReviewed: Bool?
    /// Password periods (TOTP counters) this phone already used: Loop refuses a password twice.
    public var usedCounters: [UInt64]?

    public init(otpURL: String = "", apnsKeyID: String = "", apnsKeyP8: String = "", teamID: String? = nil, returnKeyID: String? = nil, returnKeyP8: String? = nil, maxBolusUnits: Decimal = 5, maxCarbsGrams: Int = 100, bolusIncrement: Decimal = Decimal(string: "0.05")!, pinnedLoop: PinnedLoop? = nil) {
        self.otpURL = otpURL
        self.apnsKeyID = apnsKeyID
        self.apnsKeyP8 = apnsKeyP8
        self.teamID = teamID
        self.returnKeyID = returnKeyID
        self.returnKeyP8 = returnKeyP8
        self.maxBolusUnits = maxBolusUnits
        self.maxCarbsGrams = maxCarbsGrams
        self.bolusIncrement = bolusIncrement
        self.pinnedLoop = pinnedLoop
    }

    public var otp: LoopOTP? { LoopOTP(url: otpURL) }

    /// The team that built Loop: Nightscout's when it can tell, else the one typed here.
    public func loopTeamID(target: LoopRemoteTarget?) -> String? {
        target?.team_id ?? teamID.flatMap { APNsAuthToken.isTeamID($0) ? $0 : nil }
    }

    /// Every step done for this patient: Loop remembered, the QR code, a working key (and the answer key when Loop is
    /// built by another team than GlucoMind), limits seen. Until then no way to give a bolus is shown.
    public func isComplete(glucoMindTeamID: String) -> Bool {
        guard let loop = pinnedLoop, otp != nil,
              APNsAuthToken.isKeyID(apnsKeyID), (try? APNsAuthToken(keyID: apnsKeyID, teamID: loop.teamID, p8: apnsKeyP8)) != nil,
              limitsReviewed == true, maxBolusUnits > 0, maxBolusUnits <= 30, maxCarbsGrams > 0, maxCarbsGrams <= 300
        else { return false }
        if !glucoMindTeamID.isEmpty, loop.teamID != glucoMindTeamID {
            guard let id = returnKeyID, let p8 = returnKeyP8, APNsAuthToken.isKeyID(id),
                  (try? APNsAuthToken(keyID: id, teamID: glucoMindTeamID, p8: p8)) != nil else { return false }
        }
        return true
    }

    public static func isComplete(patientID: String, store: LoopRemoteSettingsStore, glucoMindTeamID: String) -> Bool {
        ((try? store.load(patientID: patientID)) ?? nil)?.isComplete(glucoMindTeamID: glucoMindTeamID) ?? false
    }

    /// What is still wrong, in the caregiver's words; empty when the settings can be used.
    public func problems(loop: LoopRemoteTarget?) -> [String] {
        var problems: [String] = []
        if otp == nil {
            problems.append("Wklej adres z kodu QR zdalnych poleceń w Loopie (Ustawienia → Nightscout).")
        }
        if !APNsAuthToken.isKeyID(apnsKeyID) {
            problems.append("Key ID klucza APNs to 10 wielkich liter lub cyfr.")
        }
        if apnsKeyP8.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            problems.append("Wczytaj klucz APNs (plik .p8) konta, które zbudowało Loopa.")
        } else if APNsAuthToken.isKeyID(apnsKeyID), (try? APNsAuthToken(keyID: apnsKeyID, teamID: loopTeamID(target: loop) ?? "AAAAAAAAAA", p8: apnsKeyP8)) == nil {
            problems.append("Klucz APNs (.p8) jest niepoprawny.")
        }
        if loopTeamID(target: loop) == nil {
            problems.append("Wpisz Team ID konta Apple, które zbudowało Loopa (Nightscout go nie podaje).")
        }
        if (returnKeyID == nil) != (returnKeyP8 == nil) {
            problems.append("Klucz do odpowiedzi Loopa wymaga Key ID i pliku .p8.")
        }
        if maxBolusUnits <= 0 || maxBolusUnits > 30 {
            problems.append("Maksymalny bolus musi być większy od 0 i nie większy niż 30 j.")
        } else if let loopMax = loop?.max_bolus_u, maxBolusUnits > loopMax {
            problems.append("Maksymalny bolus na tym telefonie (\(RemoteCommandFormat.units(maxBolusUnits)) j) jest większy niż w Loopie (\(RemoteCommandFormat.units(loopMax)) j).")
        }
        if maxCarbsGrams <= 0 || maxCarbsGrams > 300 {
            problems.append("Maksymalne węglowodany muszą być większe od 0 i nie większe niż 300 g.")
        }
        if bolusIncrement <= 0 || bolusIncrement > 1 {
            problems.append("Krok pompy musi być większy od 0 i nie większy niż 1 j.")
        }
        return problems
    }

    /// Why these amounts may not be sent from this phone (its own limits); nil when they fit.
    public func limitProblem(carbsG: Int, insulinU: Decimal) -> String? {
        if insulinU > maxBolusUnits {
            return "\(RemoteCommandFormat.units(insulinU)) j to więcej niż limit bolusa na tym telefonie (\(RemoteCommandFormat.units(maxBolusUnits)) j). Zmień dawkę albo limit w ustawieniach."
        }
        if carbsG > maxCarbsGrams {
            return "\(carbsG) g to więcej niż limit węglowodanów na tym telefonie (\(maxCarbsGrams) g). Zmień ilość albo limit w ustawieniach."
        }
        return nil
    }

    /// A password Loop has not seen from this phone: the current period's, else none yet (the caller waits for the next
    /// period). Loop accepts the previous period's too, but one sent in its last seconds may arrive expired.
    /// Loop accepts this period's password and the one before it (OTPManager keeps 2), each once. The earlier one goes
    /// first while enough of this period is left for the push to reach Loop: a meal's bolus then has this period's
    /// password at once instead of waiting up to 30 s for a new one.
    public static let earlierPasswordMargin: TimeInterval = 10

    public func unusedPassword(at date: Date) -> (password: String, counter: UInt64)? {
        guard let otp else { return nil }
        let counter = LoopOTP.counter(at: date)
        let periodLeft = Double(counter + 1) * LoopOTP.period - date.timeIntervalSince1970
        let candidates = (counter > 0 && periodLeft >= Self.earlierPasswordMargin ? [counter - 1] : []) + [counter]
        guard let free = candidates.first(where: { !(usedCounters ?? []).contains($0) }) else { return nil }
        return (otp.password(counter: free), free)
    }

    public mutating func markUsed(counter: UInt64) {
        usedCounters = Array(((usedCounters ?? []) + [counter]).suffix(8))
    }
}

/// One Loop as Nightscout describes it: a hash of its phone's push token, its app and team.
public struct PinnedLoop: Codable, Equatable, Sendable {
    public let tokenHash: String
    public let bundleID: String
    public let teamID: String
    public let pinnedAt: Date

    public init(tokenHash: String, bundleID: String, teamID: String, pinnedAt: Date) {
        self.tokenHash = tokenHash
        self.bundleID = bundleID
        self.teamID = teamID
        self.pinnedAt = pinnedAt
    }

    public init?(target: LoopRemoteTarget, teamID: String?, at date: Date) {
        guard target.isReady, let token = target.device_token, let bundle = target.bundle_id, let team = teamID else { return nil }
        self.init(tokenHash: PinnedTrio.hash(token), bundleID: bundle, teamID: team, pinnedAt: date)
    }

    public func matches(_ target: LoopRemoteTarget, teamID: String?) -> Bool {
        guard let token = target.device_token else { return false }
        return PinnedTrio.hash(token) == tokenHash && target.bundle_id == bundleID && teamID == self.teamID
    }
}

/// The guards against giving one patient's dose to another, as Trio's (TrioPatientGuard).
public enum LoopPatientGuard {
    public static func pin(settings: LoopRemoteSettings, target: LoopRemoteTarget?, patientID: String, store: LoopRemoteSettingsStore, scope: RemotePatientScope = .shared) -> TrioPatientGuard.Pin {
        guard let target, let current = PinnedLoop(target: target, teamID: settings.loopTeamID(target: target), at: Date()) else { return .notReady }
        if otherPatients(of: patientID, among: store, scope: scope).contains(where: { $0.pinnedLoop?.tokenHash == current.tokenHash }) {
            return .usedByOtherPatient
        }
        guard let pinned = settings.pinnedLoop else { return .needsConfirmation }
        return pinned.matches(target, teamID: settings.loopTeamID(target: target)) ? .confirmed : .changed
    }

    /// Another patient on this phone has the same QR code: one Loop's passwords would open the other's commands.
    public static func secretUsedByOtherPatient(_ otpURL: String, patientID: String, store: LoopRemoteSettingsStore, scope: RemotePatientScope = .shared) -> Bool {
        let trimmed = otpURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return otherPatients(of: patientID, among: store, scope: scope).contains { $0.otpURL.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed }
    }

    public static func message(_ pin: TrioPatientGuard.Pin, patientName: String?) -> String? {
        let who = patientName.map { " pacjenta \($0)" } ?? " tego pacjenta"
        switch pin {
        case .confirmed, .needsConfirmation: return nil
        case .notReady: return "Loop\(who) nie jest gotowy w Nightscout."
        case .changed: return "Nightscout\(who) pokazuje innego Loopa niż przy konfiguracji (nowa instalacja Loopa, nowy telefon albo inny Nightscout). Potwierdź go w ustawieniach zdalnego sterowania."
        case .usedByOtherPatient: return "Ten Loop jest na tym telefonie przypisany do innego pacjenta. Nic nie zostało wysłane. Jeśli tamtego pacjenta nie ma już na serwerze (np. po ponownej instalacji serwera), otwórz Mellis z dostępem do sieci: stare ustawienia znikną same po wczytaniu listy pacjentów."
        }
    }

    public static let secretMessage = "Ten kod QR jest już zapisany dla innego pacjenta na tym telefonie. Każdy Loop ma własny kod. Jeśli tamtego pacjenta nie ma już na serwerze (np. po ponownej instalacji serwera), otwórz Mellis z dostępem do sieci: stare ustawienia znikną same po wczytaniu listy pacjentów."

    /// The other patients with settings on this phone that the current session can see (RemotePatientScope): a stale
    /// id (a patient of a reinstalled server, another pairing) never blocks this patient.
    private static func otherPatients(of patientID: String, among store: LoopRemoteSettingsStore, scope: RemotePatientScope) -> [LoopRemoteSettings] {
        scope.otherPatientIDs(of: patientID, in: (try? store.patientIDs()) ?? [])
            .compactMap { (try? store.load(patientID: $0)) ?? nil }
    }
}

public protocol LoopRemoteSettingsStore {
    func load(patientID: String) throws -> LoopRemoteSettings?
    func save(_ settings: LoopRemoteSettings, patientID: String) throws
    func clear(patientID: String) throws
    func patientIDs() throws -> [String]
}

public final class KeychainLoopRemoteSettingsStore: LoopRemoteSettingsStore {
    private let items: KeychainPatientItems

    public init(service: String = "pl.glucomind.ios.loop-remote") {
        items = KeychainPatientItems(service: service)
    }

    public func load(patientID: String) throws -> LoopRemoteSettings? {
        try items.load(patientID: patientID).map { try JSONDecoder().decode(LoopRemoteSettings.self, from: $0) }
    }

    public func save(_ settings: LoopRemoteSettings, patientID: String) throws {
        try items.save(JSONEncoder().encode(settings), patientID: patientID)
    }

    public func clear(patientID: String) throws {
        try items.clear(patientID: patientID)
    }

    public func patientIDs() throws -> [String] {
        try items.patientIDs()
    }
}

/// Settings kept in memory (tests, previews).
public final class InMemoryLoopRemoteSettingsStore: LoopRemoteSettingsStore {
    private var values: [String: LoopRemoteSettings] = [:]

    public init() {}

    public func load(patientID: String) throws -> LoopRemoteSettings? { values[patientID.lowercased()] }
    public func save(_ settings: LoopRemoteSettings, patientID: String) throws { values[patientID.lowercased()] = settings }
    public func clear(patientID: String) throws { values[patientID.lowercased()] = nil }
    public func patientIDs() throws -> [String] { Array(values.keys) }
}
