import CryptoKit
import Foundation
import Security

/// What this phone needs to send commands to one patient's Trio (remote-bolus-trio-plan.md W2). Kept only in this
/// phone's Keychain: never sent to the GlucoMind server, not synced through iCloud, not readable while the phone is locked.
public struct TrioRemoteSettings: Codable, Equatable, Sendable {
    /// Trio → Remote Control → Shared Secret.
    public var sharedSecret: String
    /// The APNs key (.p8) of the Apple team that built Trio.
    public var apnsKeyID: String
    public var apnsKeyP8: String
    /// A key of GlucoMind's team for Trio's answer, only when Trio is built by another team; nil means the same key.
    public var returnKeyID: String?
    public var returnKeyP8: String?
    /// Limits checked on this phone before anything is sent; never looser than Trio's own.
    public var maxBolusUnits: Decimal
    public var maxCarbsGrams: Int
    /// The pump's bolus step; doses are rounded down to it.
    public var bolusIncrement: Decimal
    /// The Trio the caregiver confirmed as this patient's (its phone's push token, app and team). Nothing is sent while
    /// Nightscout shows another Trio, until the caregiver confirms it again.
    public var pinnedTrio: PinnedTrio?
    /// The caregiver opened the limits at least once (the defaults are not assumed to fit this patient).
    public var limitsReviewed: Bool?

    public init(
        sharedSecret: String = "",
        apnsKeyID: String = "",
        apnsKeyP8: String = "",
        returnKeyID: String? = nil,
        returnKeyP8: String? = nil,
        maxBolusUnits: Decimal = 5,
        maxCarbsGrams: Int = 100,
        bolusIncrement: Decimal = Decimal(string: "0.05")!,
        pinnedTrio: PinnedTrio? = nil
    ) {
        self.pinnedTrio = pinnedTrio
        self.sharedSecret = sharedSecret
        self.apnsKeyID = apnsKeyID
        self.apnsKeyP8 = apnsKeyP8
        self.returnKeyID = returnKeyID
        self.returnKeyP8 = returnKeyP8
        self.maxBolusUnits = maxBolusUnits
        self.maxCarbsGrams = maxCarbsGrams
        self.bolusIncrement = bolusIncrement
    }

    /// Every step of the settings is done for this patient: Trio remembered, a Shared Secret, a working key (and the key
    /// for Trio's answer when Trio is built by another Apple team than GlucoMind), limits seen. Until then the app shows
    /// no way to give a bolus to this patient.
    public func isComplete(glucoMindTeamID: String) -> Bool {
        guard let trio = pinnedTrio,
              !sharedSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              APNsAuthToken.isKeyID(apnsKeyID),
              (try? APNsAuthToken(keyID: apnsKeyID, teamID: trio.teamID, p8: apnsKeyP8)) != nil,
              limitsReviewed == true,
              maxBolusUnits > 0, maxBolusUnits <= 30, maxCarbsGrams > 0, maxCarbsGrams <= 300
        else { return false }
        if !glucoMindTeamID.isEmpty, trio.teamID != glucoMindTeamID {
            guard let id = returnKeyID, let p8 = returnKeyP8, APNsAuthToken.isKeyID(id),
                  (try? APNsAuthToken(keyID: id, teamID: glucoMindTeamID, p8: p8)) != nil else { return false }
        }
        return true
    }

    /// Whether this patient's remote control is set up on this phone (false without settings).
    public static func isComplete(patientID: String, store: TrioRemoteSettingsStore, glucoMindTeamID: String) -> Bool {
        ((try? store.load(patientID: patientID)) ?? nil)?.isComplete(glucoMindTeamID: glucoMindTeamID) ?? false
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

    /// What is still wrong, in the caregiver's words; empty when the settings can be used.
    public func problems(trio: TrioRemoteTarget?) -> [String] {
        var problems: [String] = []
        if sharedSecret.trimmingCharacters(in: .whitespaces).isEmpty {
            problems.append("Wpisz Shared Secret z Trio (Ustawienia → Remote Control).")
        }
        if !APNsAuthToken.isKeyID(apnsKeyID) {
            problems.append("Key ID klucza APNs to 10 wielkich liter lub cyfr.")
        }
        // The team only matters to APNs; any valid one shows whether the .p8 itself can sign.
        if apnsKeyP8.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            problems.append("Wczytaj klucz APNs (plik .p8).")
        } else if APNsAuthToken.isKeyID(apnsKeyID), (try? APNsAuthToken(keyID: apnsKeyID, teamID: trio?.team_id ?? "AAAAAAAAAA", p8: apnsKeyP8)) == nil {
            problems.append("Klucz APNs (.p8) jest niepoprawny.")
        }
        if (returnKeyID == nil) != (returnKeyP8 == nil) {
            problems.append("Klucz do odpowiedzi Trio wymaga Key ID i pliku .p8.")
        }
        if maxBolusUnits <= 0 || maxBolusUnits > 30 {
            problems.append("Maksymalny bolus musi być większy od 0 i nie większy niż 30 j.")
        }
        if maxCarbsGrams <= 0 || maxCarbsGrams > 300 {
            problems.append("Maksymalne węglowodany muszą być większe od 0 i nie większe niż 300 g.")
        }
        if bolusIncrement <= 0 || bolusIncrement > 1 {
            problems.append("Krok pompy musi być większy od 0 i nie większy niż 1 j.")
        }
        return problems
    }
}

/// One Trio as Nightscout describes it: a hash of its phone's push token (the token itself is not kept), its app and team.
public struct PinnedTrio: Codable, Equatable, Sendable {
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

    public init?(target: TrioRemoteTarget, at date: Date) {
        guard target.isReady, let token = target.device_token, let bundle = target.bundle_id, let team = target.team_id else { return nil }
        self.init(tokenHash: Self.hash(token), bundleID: bundle, teamID: team, pinnedAt: date)
    }

    public static func hash(_ token: String) -> String {
        SHA256.hash(data: Data(token.lowercased().utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public func matches(_ target: TrioRemoteTarget) -> Bool {
        guard let token = target.device_token else { return false }
        return Self.hash(token) == tokenHash && target.bundle_id == bundleID && target.team_id == teamID
    }
}

/// Why a command may not go to this Trio from this phone: the guards against giving one patient's dose to another.
public enum TrioPatientGuard {
    public enum Pin: Equatable {
        /// Trio is not ready in Nightscout (no token, not Trio).
        case notReady
        /// No Trio remembered for this patient yet: the first one seen (setting up, or the first send) is remembered.
        case needsConfirmation
        /// Nightscout shows another Trio than the confirmed one (a new phone, Trio reinstalled, or the wrong Nightscout).
        case changed
        /// This Trio is confirmed for another patient on this phone.
        case usedByOtherPatient
        case confirmed
    }

    public static func pin(settings: TrioRemoteSettings, target: TrioRemoteTarget?, patientID: String, store: TrioRemoteSettingsStore, scope: RemotePatientScope = .shared) -> Pin {
        guard let target, let current = PinnedTrio(target: target, at: Date()) else { return .notReady }
        if otherPatients(of: patientID, among: store, scope: scope).contains(where: { $0.pinnedTrio?.tokenHash == current.tokenHash }) {
            return .usedByOtherPatient
        }
        guard let pinned = settings.pinnedTrio else { return .needsConfirmation }
        return pinned.matches(target) ? .confirmed : .changed
    }

    /// Another patient on this phone has this Shared Secret: one Trio's secret would open the other's commands.
    public static func secretUsedByOtherPatient(_ secret: String, patientID: String, store: TrioRemoteSettingsStore, scope: RemotePatientScope = .shared) -> Bool {
        let trimmed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return otherPatients(of: patientID, among: store, scope: scope).contains { $0.sharedSecret.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed }
    }

    public static func message(_ pin: Pin, patientName: String?) -> String? {
        let who = patientName.map { " pacjenta \($0)" } ?? " tego pacjenta"
        switch pin {
        case .confirmed: return nil
        case .notReady: return "Trio\(who) nie jest gotowe w Nightscout."
        case .needsConfirmation: return nil
        case .changed: return "Nightscout\(who) pokazuje inne Trio niż przy konfiguracji (nowa instalacja Trio, nowy telefon albo inny Nightscout). Potwierdź je w ustawieniach zdalnego sterowania."
        case .usedByOtherPatient: return "To Trio jest na tym telefonie przypisane do innego pacjenta. Nic nie zostało wysłane. Jeśli tamtego pacjenta nie ma już na serwerze (np. po ponownej instalacji serwera), otwórz Mellis z dostępem do sieci: stare ustawienia znikną same po wczytaniu listy pacjentów."
        }
    }

    public static let secretMessage = "Ten Shared Secret jest już zapisany dla innego pacjenta na tym telefonie. Każde Trio musi mieć własny sekret. Jeśli tamtego pacjenta nie ma już na serwerze (np. po ponownej instalacji serwera), otwórz Mellis z dostępem do sieci: stare ustawienia znikną same po wczytaniu listy pacjentów."

    /// The other patients with settings on this phone that the current session can see (RemotePatientScope): a stale
    /// id (a patient of a reinstalled server, another pairing) never blocks this patient.
    private static func otherPatients(of patientID: String, among store: TrioRemoteSettingsStore, scope: RemotePatientScope) -> [TrioRemoteSettings] {
        scope.otherPatientIDs(of: patientID, in: (try? store.patientIDs()) ?? [])
            .compactMap { (try? store.load(patientID: $0)) ?? nil }
    }
}

public extension Notification.Name {
    /// A patient's remote control settings changed on this phone (object: the patient id).
    static let trioRemoteSettingsChanged = Notification.Name("GlucoMindTrioRemoteSettingsChanged")
}

public protocol TrioRemoteSettingsStore {
    func load(patientID: String) throws -> TrioRemoteSettings?
    func save(_ settings: TrioRemoteSettings, patientID: String) throws
    func clear(patientID: String) throws
    /// Every patient with settings on this phone.
    func patientIDs() throws -> [String]
}

public enum TrioRemoteSettingsStoreError: Error, Equatable {
    case keychain(OSStatus)
}

public final class KeychainTrioRemoteSettingsStore: TrioRemoteSettingsStore {
    private let items: KeychainPatientItems

    public init(service: String = "pl.glucomind.ios.trio-remote") {
        items = KeychainPatientItems(service: service)
    }

    public func load(patientID: String) throws -> TrioRemoteSettings? {
        try items.load(patientID: patientID).map { try JSONDecoder().decode(TrioRemoteSettings.self, from: $0) }
    }

    public func save(_ settings: TrioRemoteSettings, patientID: String) throws {
        try items.save(JSONEncoder().encode(settings), patientID: patientID)
    }

    public func clear(patientID: String) throws {
        try items.clear(patientID: patientID)
    }

    public func patientIDs() throws -> [String] {
        try items.patientIDs()
    }
}

/// One secret item per patient in the Keychain: only on this phone, only while it is unlocked, never in a backup restored
/// elsewhere. Shared by the Trio and Loop settings (each its own service).
struct KeychainPatientItems {
    let service: String

    func load(patientID: String) throws -> Data? {
        var query = baseQuery(patientID: patientID)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw TrioRemoteSettingsStoreError.keychain(status) }
        return data
    }

    func save(_ data: Data, patientID: String) throws {
        var query = baseQuery(patientID: patientID)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        query[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = SecItemUpdate(baseQuery(patientID: patientID) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard update == errSecSuccess else { throw TrioRemoteSettingsStoreError.keychain(update) }
            return
        }
        guard status == errSecSuccess else { throw TrioRemoteSettingsStoreError.keychain(status) }
    }

    func clear(patientID: String) throws {
        let status = SecItemDelete(baseQuery(patientID: patientID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TrioRemoteSettingsStoreError.keychain(status) }
    }

    func patientIDs() throws -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &items)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let rows = items as? [[String: Any]] else { throw TrioRemoteSettingsStoreError.keychain(status) }
        return rows.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    private func baseQuery(patientID: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: patientID.lowercased(),
        ]
    }
}

/// Settings kept in memory (tests, previews).
public final class InMemoryTrioRemoteSettingsStore: TrioRemoteSettingsStore {
    private var values: [String: TrioRemoteSettings] = [:]

    public init() {}

    public func load(patientID: String) throws -> TrioRemoteSettings? {
        values[patientID.lowercased()]
    }

    public func save(_ settings: TrioRemoteSettings, patientID: String) throws {
        values[patientID.lowercased()] = settings
    }

    public func clear(patientID: String) throws {
        values[patientID.lowercased()] = nil
    }

    public func patientIDs() throws -> [String] {
        Array(values.keys)
    }
}
