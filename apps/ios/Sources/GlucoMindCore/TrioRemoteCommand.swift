import CryptoKit
import Foundation

// Trio Remote Control (remote-bolus-trio-plan.md §1): a command is an APNs push sent from this phone straight to the
// patient's Trio, its JSON encrypted with AES-256-GCM under SHA-256(shared secret). The format follows Trio's
// CommandPayload / SecureMessenger and LoopFollow's sender, so a Trio that accepts LoopFollow accepts GlucoMind.

/// Command types Trio understands (Trio `CommandType` raw values). GlucoMind sends only meals and boluses.
public enum TrioCommandType: String, Codable, Sendable {
    case bolus
    case meal
}

/// The decrypted command as Trio decodes it (Trio `CommandPayload` coding keys).
public struct TrioCommandPayload: Encodable, Equatable, Sendable {
    public var user: String
    public var commandType: TrioCommandType
    /// Seconds since 1970 when the caregiver confirmed; Trio refuses a command more than 10 minutes off its clock.
    public var timestamp: TimeInterval
    public var bolusAmount: Decimal?
    public var carbs: Int?
    /// Seconds since 1970: the date Trio gives the carbs (a meal eaten later); nil: now. The bolus starts at once.
    public var scheduledTime: TimeInterval?
    /// Our command id; Trio builds that know it echo it in their answer, older builds ignore it.
    public var commandId: String?
    public var returnNotification: TrioReturnNotification?

    public init(user: String, commandType: TrioCommandType, timestamp: TimeInterval, bolusAmount: Decimal?, carbs: Int?, scheduledTime: TimeInterval? = nil, commandId: String?, returnNotification: TrioReturnNotification?) {
        self.scheduledTime = scheduledTime
        self.user = user
        self.commandType = commandType
        self.timestamp = timestamp
        self.bolusAmount = bolusAmount
        self.carbs = carbs
        self.commandId = commandId
        self.returnNotification = returnNotification
    }

    enum CodingKeys: String, CodingKey {
        case user
        case commandType = "command_type"
        case timestamp
        case bolusAmount = "bolus_amount"
        case carbs
        case scheduledTime = "scheduled_time"
        case commandId = "command_id"
        case returnNotification = "return_notification"
    }
}

/// Where Trio sends its answer: this phone's GlucoMind, signed with a key of GlucoMind's team.
public struct TrioReturnNotification: Encodable, Equatable, Sendable {
    public let productionEnvironment: Bool
    public let deviceToken: String
    public let bundleId: String
    public let teamId: String
    public let keyId: String
    public let apnsKey: String

    public init(productionEnvironment: Bool, deviceToken: String, bundleId: String, teamId: String, keyId: String, apnsKey: String) {
        self.productionEnvironment = productionEnvironment
        self.deviceToken = deviceToken
        self.bundleId = bundleId
        self.teamId = teamId
        self.keyId = keyId
        self.apnsKey = apnsKey
    }

    enum CodingKeys: String, CodingKey {
        case productionEnvironment = "production_environment"
        case deviceToken = "device_token"
        case bundleId = "bundle_id"
        case teamId = "team_id"
        case keyId = "key_id"
        case apnsKey = "apns_key"
    }
}

public enum TrioRemoteError: Error, Equatable {
    case emptySharedSecret
    case invalidAPNsKey
    case invalidTarget(String)
}

/// Trio's SecureMessenger, the encrypting side: base64(nonce 12 B + ciphertext + tag 16 B).
public struct TrioSecureMessenger {
    private let key: SymmetricKey

    public init(sharedSecret: String) throws {
        guard !sharedSecret.isEmpty else { throw TrioRemoteError.emptySharedSecret }
        key = SymmetricKey(data: SHA256.hash(data: Data(sharedSecret.utf8)))
    }

    public func encrypt(_ payload: TrioCommandPayload) throws -> String {
        try encrypt(payload, nonce: AES.GCM.Nonce())
    }

    func encrypt(_ payload: TrioCommandPayload, nonce: AES.GCM.Nonce) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let sealed = try AES.GCM.seal(try encoder.encode(payload), using: key, nonce: nonce)
        return (Data(nonce) + sealed.ciphertext + sealed.tag).base64EncodedString()
    }

    /// For tests and diagnostics: what Trio would read.
    func decrypt(_ base64: String) throws -> Data {
        guard let combined = Data(base64Encoded: base64), combined.count > 28 else { throw TrioRemoteError.invalidTarget("ciphertext") }
        let box = try AES.GCM.SealedBox(combined: combined)
        return try AES.GCM.open(box, using: key)
    }
}

/// The ES256 token APNs requires (provider authentication token), valid up to an hour; reused for 50 minutes.
public struct APNsAuthToken {
    public let keyID: String
    public let teamID: String
    private let privateKey: P256.Signing.PrivateKey

    public init(keyID: String, teamID: String, p8: String) throws {
        guard APNsAuthToken.isKeyID(keyID), APNsAuthToken.isTeamID(teamID) else { throw TrioRemoteError.invalidAPNsKey }
        privateKey = try Self.parseKey(p8)
        self.keyID = keyID
        self.teamID = teamID
    }

    public func token(issuedAt: Date) throws -> String {
        let header = try JSONSerialization.data(withJSONObject: ["alg": "ES256", "kid": keyID], options: [.sortedKeys])
        let claims = try JSONSerialization.data(withJSONObject: ["iss": teamID, "iat": Int(issuedAt.timeIntervalSince1970)], options: [.sortedKeys])
        let signingInput = header.base64URLEncoded() + "." + claims.base64URLEncoded()
        let signature = try privateKey.signature(for: Data(signingInput.utf8))
        return signingInput + "." + signature.rawRepresentation.base64URLEncoded()
    }

    /// The .p8 as Apple gives it, also with Windows line ends, a byte-order mark or the body re-wrapped.
    static func parseKey(_ p8: String) throws -> P256.Signing.PrivateKey {
        let cleaned = p8.replacingOccurrences(of: "\u{FEFF}", with: "").replacingOccurrences(of: "\r", with: "")
        if let key = try? P256.Signing.PrivateKey(pemRepresentation: cleaned.trimmingCharacters(in: .whitespacesAndNewlines)) {
            return key
        }
        let body = cleaned.components(separatedBy: "\n").filter { !$0.contains("-----") }.joined().filter { !$0.isWhitespace }
        guard let der = Data(base64Encoded: body), let key = try? P256.Signing.PrivateKey(derRepresentation: der) else {
            throw TrioRemoteError.invalidAPNsKey
        }
        return key
    }

    /// Apple key ids and team ids are 10 upper-case letters or digits.
    public static func isKeyID(_ value: String) -> Bool {
        value.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
    }

    public static func isTeamID(_ value: String) -> Bool {
        value.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
    }
}

/// The patient's Trio as its Nightscout profile describes it (GET /v1/patients/{id}/remote-control/trio).
public struct TrioRemoteTarget: Codable, Equatable, Sendable {
    /// READY, MISSING_TOKEN, NOT_TRIO or NO_PROFILE.
    public let status: String
    public let device_token: String?
    public let bundle_id: String?
    public let team_id: String?
    /// production or sandbox.
    public let apns_environment: String?
    public let profile_uploaded_at: String?
    public let remote_commands: [String]?
    public let build_expires_at: String?

    public init(status: String, device_token: String?, bundle_id: String?, team_id: String?, apns_environment: String?, profile_uploaded_at: String?, remote_commands: [String]?, build_expires_at: String?) {
        self.status = status
        self.device_token = device_token
        self.bundle_id = bundle_id
        self.team_id = team_id
        self.apns_environment = apns_environment
        self.profile_uploaded_at = profile_uploaded_at
        self.remote_commands = remote_commands
        self.build_expires_at = build_expires_at
    }

    public var isReady: Bool {
        status == "READY" && device_token != nil && bundle_id != nil && team_id != nil && apns_environment != nil
    }

    /// The settings line describing the connection.
    public var summary: String {
        switch status {
        case "READY":
            return "Trio gotowe do odbioru poleceń."
        case "MISSING_TOKEN":
            return "Trio nie wysłało jeszcze adresu do powiadomień. Otwórz Trio na telefonie pacjenta i włącz Remote Control."
        case "NOT_TRIO":
            return "Najnowszy profil w Nightscout nie pochodzi z Trio."
        default:
            return "Brak profilu z Nightscout."
        }
    }
}

public struct TrioRemoteTargetResponse: Codable, Equatable, Sendable {
    public let patient_id: String
    public let trio: TrioRemoteTarget
    /// The pump's step Trio reports, when GlucoMind rounds to it (absent on older servers).
    public var pump_bolus_step: Double? = nil

    public init(patient_id: String, trio: TrioRemoteTarget, pump_bolus_step: Double? = nil) {
        self.patient_id = patient_id
        self.trio = trio
        self.pump_bolus_step = pump_bolus_step
    }
}

/// Builds the HTTP/2 request to APNs for one command. Pure: sending is a separate step the caller takes only after the
/// caregiver confirmed and passed biometrics.
public enum TrioCommandRequestBuilder {
    public static func request(
        payload: TrioCommandPayload,
        target: TrioRemoteTarget,
        sharedSecret: String,
        authToken: APNsAuthToken,
        now: Date
    ) throws -> URLRequest {
        guard target.isReady, let deviceToken = target.device_token, let bundleID = target.bundle_id else {
            throw TrioRemoteError.invalidTarget(target.status)
        }
        guard authToken.teamID == target.team_id else {
            // APNs refuses a key of another team than the one that built Trio (403 InvalidProviderToken).
            throw TrioRemoteError.invalidTarget("TEAM_MISMATCH")
        }
        let host = target.apns_environment == "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com"
        guard let url = URL(string: "https://\(host)/3/device/\(deviceToken)") else {
            throw TrioRemoteError.invalidTarget("URL")
        }

        let encrypted = try TrioSecureMessenger(sharedSecret: sharedSecret).encrypt(payload)
        let body = TrioPushBody(encryptedData: encrypted, alert: alertText(for: payload))

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("bearer \(try authToken.token(issuedAt: now))", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("10", forHTTPHeaderField: "apns-priority")
        // Delivered now or never: APNs does not keep the command for later, so a phone that was offline never gets a
        // bolus long after the caregiver gave up on it (Trio also refuses commands older than 10 minutes).
        request.setValue("0", forHTTPHeaderField: "apns-expiration")
        request.setValue(bundleID, forHTTPHeaderField: "apns-topic")
        request.setValue("alert", forHTTPHeaderField: "apns-push-type")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        request.httpBody = try encoder.encode(body)
        return request
    }

    /// What the patient's phone shows while Trio handles the command.
    static func alertText(for payload: TrioCommandPayload) -> String {
        switch payload.commandType {
        case .bolus:
            return "Zdalne polecenie: bolus"
        case .meal:
            return payload.bolusAmount == nil ? "Zdalne polecenie: posiłek" : "Zdalne polecenie: posiłek z bolusem"
        }
    }
}

/// The push body: the encrypted command plus a visible, time-sensitive alert that wakes Trio (as LoopFollow sends it).
struct TrioPushBody: Encodable {
    let aps: APS
    let encryptedData: String

    init(encryptedData: String, alert: String) {
        self.encryptedData = encryptedData
        aps = APS(alert: alert)
    }

    struct APS: Encodable {
        let contentAvailable = 1
        let interruptionLevel = "time-sensitive"
        let alert: String

        enum CodingKeys: String, CodingKey {
            case contentAvailable = "content-available"
            case interruptionLevel = "interruption-level"
            case alert
        }
    }

    enum CodingKeys: String, CodingKey {
        case aps
        case encryptedData = "encrypted_data"
    }
}

/// How APNs answered a command push, in the caregiver's words.
public enum APNsSendResult: Equatable, Sendable {
    case accepted
    case refused(status: Int, reason: String?)

    public init(status: Int, body: Data) {
        if status == 200 {
            self = .accepted
            return
        }
        let reason = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["reason"] as? String
        self = .refused(status: status, reason: reason)
    }

    public var message: String {
        switch self {
        case .accepted:
            return "Polecenie wysłane"
        case let .refused(status, reason):
            let detail: String
            switch (status, reason) {
            case (403, _):
                detail = "klucz APNs nie pasuje do zespołu, który zbudował Trio, albo jest nieważny"
            case (400, "BadDeviceToken"), (410, _):
                detail = "adres Trio jest nieaktualny; otwórz Trio na telefonie pacjenta, żeby wysłało nowy profil"
            case (400, "DeviceTokenNotForTopic"), (400, "TopicDisallowed"):
                detail = "klucz APNs nie obsługuje tej aplikacji Trio"
            case (429, _):
                detail = "Apple ogranicza liczbę wysyłek; spróbuj za chwilę"
            case (500, _), (503, _):
                detail = "serwer Apple jest chwilowo niedostępny"
            default:
                detail = "APNs odpowiedział \(status)\(reason.map { " (\($0))" } ?? "")"
            }
            return "Nie udało się wysłać: \(detail)"
        }
    }
}

extension Data {
    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
