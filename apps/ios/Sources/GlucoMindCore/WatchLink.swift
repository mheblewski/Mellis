import Foundation
import Security
import CryptoKit

/// The phone → Apple Watch hand-over (WatchConnectivity application context). The watch never signs in: the phone
/// creates a read-only watch token for it (POST /v1/me/watch-devices, watch-glance.v1) and sends it with the server's
/// address and the token's patients; the watch reads GET /v1/watch/glance with it. Shared by the phone app and the
/// watch targets (project.yml), so both sides read and write the same keys.
public enum WatchLink {
    public static let watchTokenKey = "watchToken"
    public static let baseURLKey = "baseURL"
    public static let patientsKey = "patients"
    public static let signedOutKey = "signedOut"
    /// Watch → phone (message or user info): the server refused this token (its fingerprint); the phone makes a new one.
    public static let rejectedTokenKey = "rejectedToken"
    /// Watch → phone (message): "send me the current context".
    public static let requestKey = "request"
    /// Phone → watch: added to a re-send, because WatchConnectivity does not deliver an identical context again.
    public static let sentAtKey = "sentAt"

    public struct Patient: Codable, Equatable, Hashable {
        public let id: String
        public let name: String

        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    /// What the watch keeps (its Keychain group): the token, the server and the token's patients.
    public struct Credentials: Codable, Equatable {
        public let token: String
        public let baseURL: URL
        public let patients: [Patient]

        public init(token: String, baseURL: URL, patients: [Patient]) {
            self.token = token
            self.baseURL = baseURL
            self.patients = patients
        }
    }

    public enum Message: Equatable {
        case signedOut
        case credentials(Credentials)
    }

    public static let signedOutContext: [String: Any] = [signedOutKey: true]

    public static func context(_ credentials: Credentials) -> [String: Any] {
        [
            watchTokenKey: credentials.token,
            baseURLKey: credentials.baseURL.absoluteString,
            patientsKey: credentials.patients.map { ["id": $0.id, "name": $0.name] },
        ]
    }

    /// The same context again, delivered as a new one.
    public static func resent(_ context: [String: Any], at date: Date) -> [String: Any] {
        context.merging([sentAtKey: date.timeIntervalSince1970]) { _, new in new }
    }

    /// Whether two contexts say the same, whenever they were sent.
    public static func sameContext(_ first: [String: Any], _ second: [String: Any]) -> Bool {
        var first = first
        var second = second
        first[sentAtKey] = nil
        second[sentAtKey] = nil
        return NSDictionary(dictionary: first).isEqual(to: second)
    }

    /// Nil for anything else (an empty context, an older build's keys).
    public static func parse(_ context: [String: Any]) -> Message? {
        if context[signedOutKey] as? Bool == true { return .signedOut }
        guard let token = context[watchTokenKey] as? String, isWatchTokenShape(token),
              let raw = context[baseURLKey] as? String, let baseURL = URL(string: raw), baseURL.scheme != nil else { return nil }
        let patients = (context[patientsKey] as? [[String: String]] ?? []).compactMap { entry -> Patient? in
            guard let id = entry["id"], let name = entry["name"] else { return nil }
            return Patient(id: id, name: name)
        }
        return .credentials(Credentials(token: token, baseURL: baseURL, patients: patients))
    }

    /// gmw_ + 43 base64url characters (the server's watch token).
    public static func isWatchTokenShape(_ token: String) -> Bool {
        token.range(of: "^gmw_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    /// A short, stable name of a token that says which one without revealing it (sha256, 16 hex characters).
    public static func fingerprint(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}

/// One Codable value as a Keychain item (generic password), optionally in an access group.
public struct KeychainCodableItem<Value: Codable> {
    private let service: String
    private let account: String
    private let accessGroup: String?

    public init(service: String, account: String, accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func load() -> Value? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    public func save(_ value: Value) throws {
        let data = try JSONEncoder().encode(value)
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        }
        guard status == errSecSuccess else { throw APIClientError.invalidResponse }
    }

    public func clear() {
        SecItemDelete(baseQuery as CFDictionary)
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

/// The phone's own record of the watch device it created for its paired Apple Watch.
public struct WatchDeviceRecord: Codable, Equatable {
    public let deviceID: String
    public let token: String
    public let baseURL: URL
    public let patients: [WatchLink.Patient]

    public init(deviceID: String, token: String, baseURL: URL, patients: [WatchLink.Patient]) {
        self.deviceID = deviceID
        self.token = token
        self.baseURL = baseURL
        self.patients = patients
    }

    public var credentials: WatchLink.Credentials {
        WatchLink.Credentials(token: token, baseURL: baseURL, patients: patients)
    }
}
