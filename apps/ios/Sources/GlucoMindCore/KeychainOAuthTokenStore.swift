import Foundation
import Security

/// The Cognito tokens in the Keychain. With an access group (the app and its home-screen widget share one), the item
/// lives in that group; an item saved before the group existed (in the app's own group) is moved into it on first read.
public final class KeychainOAuthTokenStore: OAuthTokenStore {
    private let service: String
    private let account: String
    private let accessGroup: String?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(service: String, account: String, accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Service and account of the caregiver's session, the same in the app and the widget.
    public static func session(accessGroup: String?) -> KeychainOAuthTokenStore {
        KeychainOAuthTokenStore(service: "pl.glucomind.ios.auth", account: "cognito.tokens", accessGroup: accessGroup)
    }

    public func load() throws -> OAuthTokenSet? {
        if let data = try copyData(query: groupQuery) {
            return try decoder.decode(OAuthTokenSet.self, from: data)
        }
        guard accessGroup != nil, let legacy = try copyLegacy() else {
            return nil
        }
        let tokenSet = try decoder.decode(OAuthTokenSet.self, from: legacy.data)
        // Moved into the shared group so the widget can read it; the old copy goes only once the new one is saved.
        if addStatus(legacy.data) == errSecSuccess, let group = legacy.group {
            var old = baseQuery
            old[kSecAttrAccessGroup as String] = group
            SecItemDelete(old as CFDictionary)
        }
        return tokenSet
    }

    public func save(_ tokenSet: OAuthTokenSet) throws {
        let data = try encoder.encode(tokenSet)
        let status = addStatus(data)
        if status == errSecDuplicateItem {
            let attributes: [String: Any] = [kSecValueData as String: data]
            let updateStatus = SecItemUpdate(groupQuery as CFDictionary, attributes as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw APIClientError.invalidResponse
            }
            return
        }

        guard status == errSecSuccess else {
            throw APIClientError.invalidResponse
        }
    }

    /// Every copy, in any group this app can reach.
    public func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw APIClientError.invalidResponse
        }
    }

    private func addStatus(_ data: Data) -> OSStatus {
        var query = groupQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil)
    }

    private func copyData(query base: [String: Any]) throws -> Data? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status != errSecItemNotFound else {
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw APIClientError.invalidResponse
        }
        return data
    }

    /// The item in any group (the shared one already came up empty), with the group it is in.
    private func copyLegacy() throws -> (data: Data, group: String?)? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status != errSecItemNotFound else {
            return nil
        }
        guard status == errSecSuccess,
              let attributes = item as? [String: Any],
              let data = attributes[kSecValueData as String] as? Data else {
            throw APIClientError.invalidResponse
        }
        return (data, attributes[kSecAttrAccessGroup as String] as? String)
    }

    private var groupQuery: [String: Any] {
        var query = baseQuery
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

/// The session's tokens as the widget sees them: it refreshes and saves them like the app, but never deletes them. A
/// refresh the widget sees rejected (the app may have just signed in again) must not sign the caregiver out of the app.
public struct NonClearingTokenStore: OAuthTokenStore {
    private let base: OAuthTokenStore

    public init(_ base: OAuthTokenStore) {
        self.base = base
    }

    public func load() throws -> OAuthTokenSet? { try base.load() }
    public func save(_ tokenSet: OAuthTokenSet) throws { try base.save(tokenSet) }
    public func clear() throws {}
}
