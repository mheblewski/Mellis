import Foundation

/// The patients the current session can see (GET /v1/me/patients on the server this phone is paired with). Trio / Loop
/// settings this phone keeps for any other patient id are stale (the server was reinstalled or restored from a backup
/// with new ids, the phone was paired elsewhere): they never make the guards block a visible patient's commands. Two
/// visible patients still never share a Trio, a Loop or a secret.
///
/// Until the list has loaded (`visiblePatientIDs` nil) every patient with settings on this phone counts, as before.
public final class RemotePatientScope: @unchecked Sendable {
    public static let shared = RemotePatientScope()

    private let lock = NSLock()
    private var ids: Set<String>?

    public init(visiblePatientIDs: [String]? = nil) {
        ids = visiblePatientIDs.map { Set($0.map { $0.lowercased() }) }
    }

    /// The visible patients (lowercased), nil while not known.
    public var visiblePatientIDs: Set<String>? {
        lock.lock(); defer { lock.unlock() }
        return ids
    }

    /// The patient list just loaded successfully.
    public func update(visiblePatientIDs: [String]) {
        lock.lock(); defer { lock.unlock() }
        ids = Set(visiblePatientIDs.map { $0.lowercased() })
    }

    /// Signed out, unpaired or paired elsewhere: nothing is known about the next session's patients.
    public func reset() {
        lock.lock(); defer { lock.unlock() }
        ids = nil
    }

    /// Whether another patient's settings take part in the guards: yes while the list is unknown, else only when visible.
    public func counts(_ patientID: String) -> Bool {
        guard let ids = visiblePatientIDs else { return true }
        return ids.contains(patientID.lowercased())
    }

    /// Ids in `ids` other than `patientID` that the guards compare with.
    func otherPatientIDs(of patientID: String, in ids: [String]) -> [String] {
        ids.filter { $0.lowercased() != patientID.lowercased() && counts($0) }
    }
}

/// Removes Trio / Loop settings (secrets, keys, the confirmed Trio / Loop, limits) this phone keeps for patients the
/// session can no longer see. Only ever after a successful, non-empty patient list: a network error or an empty answer
/// never wipes anything.
public enum RemoteSettingsCleanup {
    /// The patient list was read (GET /v1/me/patients). A success with patients: the guards compare only with them and
    /// every other patient's settings are removed (the removed ids are returned). A failure or an empty list changes
    /// nothing: neither the scope nor any settings.
    @discardableResult
    public static func patientListLoaded(_ result: Result<[String], Error>, scope: RemotePatientScope = .shared, trioStore: TrioRemoteSettingsStore, loopStore: LoopRemoteSettingsStore) -> [String] {
        guard case let .success(ids) = result, !ids.isEmpty else { return [] }
        scope.update(visiblePatientIDs: ids)
        return removeSettings(notIn: ids, trioStore: trioStore, loopStore: loopStore)
    }

    /// Keeps the settings of `visiblePatientIDs`, removes every other patient's. Returns the removed ids. An empty list
    /// removes nothing (it may be a server that has not loaded its patients yet).
    @discardableResult
    public static func removeSettings(notIn visiblePatientIDs: [String], trioStore: TrioRemoteSettingsStore, loopStore: LoopRemoteSettingsStore) -> [String] {
        let visible = Set(visiblePatientIDs.map { $0.lowercased() })
        guard !visible.isEmpty else { return [] }
        var removed: [String] = []
        // A Keychain that cannot be read (the phone locked) removes nothing; the guards still ignore stale ids.
        for id in (try? trioStore.patientIDs()) ?? [] where !visible.contains(id.lowercased()) {
            if (try? trioStore.clear(patientID: id)) != nil { removed.append(id.lowercased()) }
        }
        for id in (try? loopStore.patientIDs()) ?? [] where !visible.contains(id.lowercased()) {
            if (try? loopStore.clear(patientID: id)) != nil, !removed.contains(id.lowercased()) { removed.append(id.lowercased()) }
        }
        for id in removed {
            NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: id)
        }
        return removed
    }

    /// Every patient's settings go ("Odłącz ten telefon", a pairing with another server).
    @discardableResult
    public static func removeAll(trioStore: TrioRemoteSettingsStore, loopStore: LoopRemoteSettingsStore) -> [String] {
        var removed: [String] = []
        for id in (try? trioStore.patientIDs()) ?? [] where (try? trioStore.clear(patientID: id)) != nil {
            removed.append(id.lowercased())
        }
        for id in (try? loopStore.patientIDs()) ?? [] where (try? loopStore.clear(patientID: id)) != nil {
            if !removed.contains(id.lowercased()) { removed.append(id.lowercased()) }
        }
        for id in removed {
            NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: id)
        }
        return removed
    }

    /// The server the settings on this phone were made with changed (a pairing with another server): all settings go.
    /// The first call on a phone only remembers the server. Returns whether anything was cleared.
    @discardableResult
    public static func serverChanged(to server: URL, defaults: UserDefaults = .standard, trioStore: TrioRemoteSettingsStore, loopStore: LoopRemoteSettingsStore) -> Bool {
        let current = PairingLink.origin(server)
        let previous = defaults.string(forKey: serverKey)
        defaults.set(current, forKey: serverKey)
        guard let previous, previous != current else { return false }
        removeAll(trioStore: trioStore, loopStore: loopStore)
        return true
    }

    /// Unpaired: the next pairing starts without a remembered server.
    public static func forgetServer(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: serverKey)
    }

    static let serverKey = "MellisRemoteSettingsServer"
}
