import Foundation
import Security

/// What this phone knows about its pairing (device mode): the server it pairs with (from the QR code, never from the
/// build) and the device id the server gave it. Kept in the Keychain group shared with the widget, so the widget and
/// the Live Activity refresh reach the same server as the same device.
public struct DevicePairing: Codable, Equatable, Sendable {
    public let serverURL: URL
    public let deviceID: String
    public let userID: String?
    /// The person's first name as the server stores it.
    public var displayName: String?
    public let pairedAt: Date

    public init(serverURL: URL, deviceID: String, userID: String?, displayName: String?, pairedAt: Date) {
        self.serverURL = serverURL
        self.deviceID = deviceID
        self.userID = userID
        self.displayName = displayName
        self.pairedAt = pairedAt
    }
}

/// The current session token (15 min), shared by the app and the widget so they do not each start one.
public struct DeviceSessionToken: Codable, Equatable, Sendable {
    public let accessToken: String
    public let expiresAt: Date

    public init(accessToken: String, expiresAt: Date) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
    }
}

public protocol DevicePairingStore: AnyObject, Sendable {
    func loadPairing() throws -> DevicePairing?
    func savePairing(_ pairing: DevicePairing) throws
    func loadSession() throws -> DeviceSessionToken?
    func saveSession(_ session: DeviceSessionToken) throws
    func clearSession()
    /// The pairing and its session (the keys are the key store's).
    func clear()
}

public final class KeychainDevicePairingStore: DevicePairingStore, @unchecked Sendable {
    private let pairingItem: KeychainDataItem
    private let sessionItem: KeychainDataItem
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(accessGroup: String?) {
        pairingItem = KeychainDataItem(service: "pl.mellis.device-auth", account: "pairing", accessGroup: accessGroup)
        sessionItem = KeychainDataItem(service: "pl.mellis.device-auth", account: "session", accessGroup: accessGroup)
    }

    public func loadPairing() throws -> DevicePairing? {
        try pairingItem.load().map { try decoder.decode(DevicePairing.self, from: $0) }
    }

    public func savePairing(_ pairing: DevicePairing) throws {
        try pairingItem.save(try encoder.encode(pairing))
    }

    public func loadSession() throws -> DeviceSessionToken? {
        try sessionItem.load().flatMap { try? decoder.decode(DeviceSessionToken.self, from: $0) }
    }

    public func saveSession(_ session: DeviceSessionToken) throws {
        try sessionItem.save(try encoder.encode(session))
    }

    public func clearSession() {
        try? sessionItem.delete()
    }

    public func clear() {
        try? sessionItem.delete()
        try? pairingItem.delete()
    }
}

/// Tests and previews.
public final class InMemoryDevicePairingStore: DevicePairingStore, @unchecked Sendable {
    private let lock = NSLock()
    private var pairing: DevicePairing?
    private var session: DeviceSessionToken?
    public private(set) var savedSessions: [DeviceSessionToken] = []

    public init(pairing: DevicePairing? = nil, session: DeviceSessionToken? = nil) {
        self.pairing = pairing
        self.session = session
    }

    public func loadPairing() throws -> DevicePairing? { lock.withLock { pairing } }
    public func savePairing(_ pairing: DevicePairing) throws { lock.withLock { self.pairing = pairing } }
    public func loadSession() throws -> DeviceSessionToken? { lock.withLock { session } }
    public func saveSession(_ session: DeviceSessionToken) throws {
        lock.withLock {
            self.session = session
            savedSessions.append(session)
        }
    }
    public func clearSession() { lock.withLock { session = nil } }
    public func clear() { lock.withLock { session = nil; pairing = nil } }
}

/// The pairing as the widget sees it: it renews the shared session like the app, but never forgets the pairing (only
/// the app returns to the pairing screen).
public final class NonClearingDevicePairingStore: DevicePairingStore, @unchecked Sendable {
    private let base: DevicePairingStore

    public init(_ base: DevicePairingStore) {
        self.base = base
    }

    public func loadPairing() throws -> DevicePairing? { try base.loadPairing() }
    public func savePairing(_ pairing: DevicePairing) throws { try base.savePairing(pairing) }
    public func loadSession() throws -> DeviceSessionToken? { try base.loadSession() }
    public func saveSession(_ session: DeviceSessionToken) throws { try base.saveSession(session) }
    public func clearSession() { base.clearSession() }
    public func clear() {}
}

/// One generic-password Keychain item, readable after the first unlock on this phone only (never in backups), in the
/// access group shared with the widget when one is given.
public struct KeychainDataItem {
    public let service: String
    public let account: String
    public let accessGroup: String?

    public init(service: String, account: String, accessGroup: String?) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func load() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainItemError(status: status)
        }
        return data
    }

    public func save(_ data: Data) throws {
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard update == errSecSuccess else { throw KeychainItemError(status: update) }
            return
        }
        guard status == errSecSuccess else { throw KeychainItemError(status: status) }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainItemError(status: status) }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

public struct KeychainItemError: Error, Equatable {
    public let status: OSStatus
}
