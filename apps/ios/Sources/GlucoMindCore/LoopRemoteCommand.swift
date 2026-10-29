import CryptoKit
import Foundation

// Loop's remote commands (loop-support-plan.md, stage 3): an APNs push from this phone straight to the patient's Loop,
// like Trio's, but in Loop's own format (LoopKit NightscoutService RemoteCommandSourceV1 / BolusRemoteNotification /
// CarbRemoteNotification; LoopFollow's LoopAPNSService sends the same). The JSON is not encrypted: a one-time password
// (TOTP from the QR code in Loop's Nightscout service settings) proves it, and only the address for Loop's answer is
// encrypted, under SHA-256 of that password (OTPSecureMessenger).

/// Where a command for the patient's Loop goes (GET remote-control/loop).
public struct LoopRemoteTarget: Codable, Equatable, Sendable {
    /// READY, MISSING_TOKEN, NOT_LOOP or NO_PROFILE.
    public let status: String
    public let device_token: String?
    public let bundle_id: String?
    /// From a LoopWorkspace bundle id; nil otherwise (the caregiver types it in the settings).
    public let team_id: String?
    /// production or sandbox.
    public let apns_environment: String?
    public let profile_uploaded_at: String?
    /// Loop's own bolus limit, U.
    public let max_bolus_u: Decimal?

    public init(status: String, device_token: String?, bundle_id: String?, team_id: String?, apns_environment: String?, profile_uploaded_at: String?, max_bolus_u: Decimal?) {
        self.status = status
        self.device_token = device_token
        self.bundle_id = bundle_id
        self.team_id = team_id
        self.apns_environment = apns_environment
        self.profile_uploaded_at = profile_uploaded_at
        self.max_bolus_u = max_bolus_u
    }

    public var isReady: Bool {
        status == "READY" && device_token != nil && bundle_id != nil && apns_environment != nil
    }

    public var summary: String {
        switch status {
        case "READY": return "Loop gotowy do odbioru poleceń."
        case "MISSING_TOKEN": return "Loop nie wysłał jeszcze adresu do powiadomień. W Loopie: Ustawienia → Nightscout → włącz zdalne polecenia (Remote Commands)."
        case "NOT_LOOP": return "Najnowszy profil w Nightscout nie pochodzi z Loopa."
        default: return "W Nightscout nie ma jeszcze profilu Loopa."
        }
    }
}

public struct LoopRemoteTargetResponse: Codable, Equatable, Sendable {
    public let patient_id: String
    public let loop: LoopRemoteTarget
    public let pump_bolus_step: Decimal?
}

/// The one-time passwords of Loop's QR code (`otpauth://totp/…?secret=…`): RFC 6238 with SHA-1, 6 digits, 30 s, as
/// LoopKit's OTPManager makes them. Loop accepts the current and the previous password, each once.
public struct LoopOTP: Equatable, Sendable {
    public static let period: TimeInterval = 30
    public static let digits = 6

    private let secret: Data

    /// From the QR code's URL; nil when it is not a TOTP URL with a base32 secret.
    public init?(url: String) {
        guard let components = URLComponents(string: url.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "otpauth", components.host?.lowercased() == "totp",
              let secret = components.queryItems?.first(where: { $0.name.lowercased() == "secret" })?.value,
              let decoded = Self.base32Decode(secret), !decoded.isEmpty
        else { return nil }
        let items = components.queryItems ?? []
        // LoopKit always writes SHA1, 6 digits, 30 s; another QR code would make passwords Loop refuses.
        if let algorithm = items.first(where: { $0.name.lowercased() == "algorithm" })?.value, algorithm.uppercased() != "SHA1" { return nil }
        if let digits = items.first(where: { $0.name.lowercased() == "digits" })?.value, digits != String(Self.digits) { return nil }
        if let period = items.first(where: { $0.name.lowercased() == "period" })?.value, period != String(Int(Self.period)) { return nil }
        self.secret = decoded
    }

    /// The period a moment falls in (its counter).
    public static func counter(at date: Date) -> UInt64 {
        UInt64(max(0, date.timeIntervalSince1970) / period)
    }

    public func password(counter: UInt64) -> String {
        var big = counter.bigEndian
        let message = Data(bytes: &big, count: MemoryLayout<UInt64>.size)
        let mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: SymmetricKey(data: secret)))
        let offset = Int(mac[mac.count - 1] & 0x0F)
        let value = (UInt32(mac[offset] & 0x7F) << 24) | (UInt32(mac[offset + 1]) << 16) | (UInt32(mac[offset + 2]) << 8) | UInt32(mac[offset + 3])
        return String(format: "%06d", value % 1_000_000)
    }

    public func password(at date: Date) -> String {
        password(counter: Self.counter(at: date))
    }

    static func base32Decode(_ text: String) -> Data? {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var buffer = 0
        var bits = 0
        var bytes: [UInt8] = []
        for character in text.uppercased() where character != "=" && character != " " {
            guard let index = alphabet.firstIndex(of: character) else { return nil }
            buffer = (buffer << 5) | index
            bits += 5
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8((buffer >> bits) & 0xFF))
            }
        }
        return Data(bytes)
    }
}

/// The two pushes a Loop command can be: carbs (with their absorption and date) or a bolus.
public enum LoopCommandStep: String, Codable, Equatable, Sendable {
    case carbs
    case bolus
}

public enum LoopCommandRequestBuilder {
    /// Loop's default for a meal of unknown speed ("medium", 3 h), as LoopFollow sends it.
    public static let absorptionHours: Double = 3
    /// How long the push is valid for Loop (`expiration`); APNs itself keeps it for no time at all.
    public static let validity: TimeInterval = 5 * 60

    public static func request(
        step: LoopCommandStep,
        carbsG: Int,
        insulinU: Decimal,
        carbsAt: Date?,
        otp: String,
        commandID: String,
        returnNotification: TrioReturnNotification,
        target: LoopRemoteTarget,
        teamID: String,
        authToken: APNsAuthToken,
        now: Date
    ) throws -> URLRequest {
        guard target.isReady, let deviceToken = target.device_token, let bundleID = target.bundle_id else {
            throw TrioRemoteError.invalidTarget(target.status)
        }
        guard authToken.teamID == teamID else { throw TrioRemoteError.invalidTarget("TEAM_MISMATCH") }
        let host = target.apns_environment == "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com"
        guard let url = URL(string: "https://\(host)/3/device/\(deviceToken)") else { throw TrioRemoteError.invalidTarget("URL") }

        let alert: String
        var body: [String: Any] = [
            "otp": otp,
            // Loop copies it into the Nightscout note of a push it refuses: the server finds the command by it.
            "remote-address": "Mellis:\(commandID.lowercased()):\(step.rawValue)",
            "entered-by": "Mellis",
            "notes": "Mellis",
            "sent-at": isoDate(now),
            "expiration": isoDate(now.addingTimeInterval(validity)),
            "encrypted_return_notification": try LoopReturnEncryption.encrypt(returnNotification, otp: otp),
        ]
        switch step {
        case .carbs:
            body["carbs-entry"] = carbsG
            body["absorption-time"] = absorptionHours
            body["start-time"] = isoDate(carbsAt ?? now)
            alert = "Mellis: \(carbsG) g węglowodanów"
        case .bolus:
            body["bolus-entry"] = NSDecimalNumber(decimal: insulinU).doubleValue
            alert = "Mellis: bolus \(RemoteCommandFormat.units(insulinU)) j"
        }
        body["aps"] = ["alert": alert, "content-available": 1, "interruption-level": "time-sensitive"] as [String: Any]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("bearer \(try authToken.token(issuedAt: now))", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("10", forHTTPHeaderField: "apns-priority")
        // Delivered now or never, as Trio's: a phone that was offline never gets a bolus long after it was confirmed.
        request.setValue("0", forHTTPHeaderField: "apns-expiration")
        request.setValue(bundleID, forHTTPHeaderField: "apns-topic")
        request.setValue("alert", forHTTPHeaderField: "apns-push-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return request
    }

    static func isoDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// Loop's OTPSecureMessenger: AES-GCM under SHA-256 of the one-time password; nonce (12 B) + ciphertext + tag (16 B), base64.
/// The address inside is Loop's ReturnNotificationInfo, with the same snake_case keys as Trio's (production_environment,
/// device_token, …): Loop cannot read any other spelling and then sends no answer at all.
public enum LoopReturnEncryption {
    public static func encrypt(_ info: TrioReturnNotification, otp: String) throws -> String {
        let key = SymmetricKey(data: SHA256.hash(data: Data(otp.utf8)))
        let sealed = try AES.GCM.seal(try JSONEncoder().encode(info), using: key, nonce: AES.GCM.Nonce())
        return (Data(sealed.nonce) + sealed.ciphertext + sealed.tag).base64EncodedString()
    }

    /// The other side (tests): what Loop reads.
    static func decrypt(_ base64: String, otp: String) throws -> Data {
        guard let combined = Data(base64Encoded: base64), combined.count > 28 else { throw TrioRemoteError.invalidTarget("ciphertext") }
        let key = SymmetricKey(data: SHA256.hash(data: Data(otp.utf8)))
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: combined.prefix(12)), ciphertext: combined.dropFirst(12).dropLast(16), tag: combined.suffix(16))
        return try AES.GCM.open(box, using: key)
    }
}

/// Loop's answer push (RemoteNotificationResponseManager): `command_status` success/failed, `command_type` carbs/bolus,
/// its text in aps.alert.body. It carries no command id: it is matched to this phone's pending Loop command.
public struct LoopReply: Equatable {
    public let success: Bool
    public let step: LoopCommandStep
    public let message: String

    public static func parse(userInfo: [AnyHashable: Any]) -> LoopReply? {
        guard let status = userInfo["command_status"] as? String, status == "success" || status == "failed",
              let type = userInfo["command_type"] as? String, let step = LoopCommandStep(rawValue: type) else { return nil }
        let aps = userInfo["aps"] as? [String: Any]
        let alert = aps?["alert"]
        let body = (alert as? [String: Any])?["body"] as? String ?? (alert as? String) ?? ""
        return LoopReply(success: status == "success", step: step, message: body)
    }
}
