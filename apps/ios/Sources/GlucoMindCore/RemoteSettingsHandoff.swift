import CryptoKit
import Foundation

// "Przekaż moje ustawienia Trio/Loop" (docs/device-auth-api.md §8): an owner's phone hands its loop
// remote-command settings for one patient (Trio: Shared Secret + APNs key; Loop: the QR code's otpauth URL + APNs key
// and team; the answer key; the limits; the confirmed Trio/Loop) to each phone of a person with a remote bolus grant,
// so that person types nothing. End to end: encrypted on the owner's phone to each recipient phone's own P-256 key
// (ECIES, DeviceKeyECIES), signed with the owner's device key; the server stores only ciphertext.

public enum HandoffLoopKind: String, Codable, Equatable, Sendable {
    case trio, loop

    public var displayName: String { self == .trio ? "Trio" : "Loop" }
}

/// Which key of the recipient phone a package is encrypted to: the Face ID bound bolus key (decrypting asks Face ID),
/// or the device key while the phone has no bolus key yet (the person has not confirmed remote bolus there).
public enum HandoffRecipientKey: String, Codable, Equatable, Sendable {
    case bolus, device
}

// MARK: - Server JSON

/// GET /v1/patients/:id/people/:userId/handoff-devices
public struct HandoffDevice: Codable, Equatable, Sendable {
    public let device_id: String
    public let name: String
    public let recipient_key: HandoffRecipientKey
    /// base64 X9.63 of the key to encrypt to.
    public let encryption_public_key: String

    public init(device_id: String, name: String, recipient_key: HandoffRecipientKey, encryption_public_key: String) {
        self.device_id = device_id
        self.name = name
        self.recipient_key = recipient_key
        self.encryption_public_key = encryption_public_key
    }
}

public struct HandoffDevicesResponse: Codable, Equatable, Sendable {
    public let patient_id: String
    public let user_id: String
    public let display_name: String?
    public let devices: [HandoffDevice]
}

public struct HandoffPackageBody: Codable, Equatable, Sendable {
    public let to_device_id: String
    public let recipient_key: HandoffRecipientKey
    /// base64 of the ECIES message.
    public let ciphertext: String
    /// base64 DER signature of the owner's device key over `RemoteSettingsHandoffCrypto.message`.
    public let sender_signature: String
}

public struct HandoffCreateBody: Encodable, Equatable, Sendable {
    public let to_user_id: String
    public let loop_kind: HandoffLoopKind
    public let packages: [HandoffPackageBody]
}

public struct HandoffCreated: Decodable, Equatable, Sendable {
    public let handoff_id: String
    public let to_device_id: String
    public let expires_at: String
}

public struct HandoffCreateResponse: Decodable, Equatable, Sendable {
    public let handoffs: [HandoffCreated]
}

/// A package as the server lists it (never with its ciphertext): waiting for this phone, or an owner's receipt.
public struct RemoteSettingsHandoff: Codable, Equatable, Identifiable, Sendable {
    public let handoff_id: String
    public let patient_id: String
    public let patient_name: String
    public let from_user_id: String
    public let from_name: String
    public let from_device_id: String
    public let from_device_public_key: String
    public let to_user_id: String
    public let to_name: String
    public let to_device_id: String
    public let to_device_name: String
    public let loop_kind: HandoffLoopKind
    public let recipient_key: HandoffRecipientKey
    public let created_at: String
    public let expires_at: String
    public var consumed_at: String?

    public var id: String { handoff_id }

    /// "Tomek przekazał Ci ustawienia Trio dla: Zosia"
    public var title: String {
        "\(from_name) przekazał Ci ustawienia \(loop_kind.displayName) dla: \(patient_name)"
    }
}

public struct RemoteSettingsHandoffsResponse: Decodable, Equatable, Sendable {
    public let handoffs: [RemoteSettingsHandoff]
}

/// POST /v1/me/remote-settings-handoffs/:id/consume: the package, once.
public struct ConsumedHandoff: Decodable, Equatable, Sendable {
    public let handoff: RemoteSettingsHandoff
    public let ciphertext: String
    public let sender_signature: String

    private enum CodingKeys: String, CodingKey { case ciphertext, sender_signature }

    public init(handoff: RemoteSettingsHandoff, ciphertext: String, sender_signature: String) {
        self.handoff = handoff
        self.ciphertext = ciphertext
        self.sender_signature = sender_signature
    }

    public init(from decoder: Decoder) throws {
        handoff = try RemoteSettingsHandoff(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ciphertext = try container.decode(String.self, forKey: .ciphertext)
        sender_signature = try container.decode(String.self, forKey: .sender_signature)
    }
}

public protocol RemoteSettingsHandoffAPI {
    func handoffDevices(patientID: String, userID: String) async throws -> HandoffDevicesResponse
    func createHandoff(patientID: String, body: HandoffCreateBody) async throws -> HandoffCreateResponse
    func listPatientHandoffs(patientID: String) async throws -> [RemoteSettingsHandoff]
    func revokeHandoff(patientID: String, handoffID: String) async throws
    func listMyHandoffs() async throws -> [RemoteSettingsHandoff]
    func consumeHandoff(handoffID: String) async throws -> ConsumedHandoff
    func rejectHandoff(handoffID: String) async throws
}

extension APIClient: RemoteSettingsHandoffAPI {
    public func handoffDevices(patientID: String, userID: String) async throws -> HandoffDevicesResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/people/\(Self.handoffSegment(userID))/handoff-devices", method: "GET")
        return try await decode(request, as: HandoffDevicesResponse.self)
    }

    public func createHandoff(patientID: String, body: HandoffCreateBody) async throws -> HandoffCreateResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-settings-handoffs", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(body)
        return try await decode(request, as: HandoffCreateResponse.self)
    }

    public func listPatientHandoffs(patientID: String) async throws -> [RemoteSettingsHandoff] {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-settings-handoffs", method: "GET")
        return try await decode(request, as: RemoteSettingsHandoffsResponse.self).handoffs
    }

    public func revokeHandoff(patientID: String, handoffID: String) async throws {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/remote-settings-handoffs/\(Self.handoffSegment(handoffID))", method: "DELETE")
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    public func listMyHandoffs() async throws -> [RemoteSettingsHandoff] {
        let request = try await makeRequest(path: "/v1/me/remote-settings-handoffs", method: "GET")
        return try await decode(request, as: RemoteSettingsHandoffsResponse.self).handoffs
    }

    public func consumeHandoff(handoffID: String) async throws -> ConsumedHandoff {
        let request = try await makeRequest(path: "/v1/me/remote-settings-handoffs/\(Self.handoffSegment(handoffID))/consume", method: "POST")
        return try await decode(request, as: ConsumedHandoff.self)
    }

    public func rejectHandoff(handoffID: String) async throws {
        let request = try await makeRequest(path: "/v1/me/remote-settings-handoffs/\(Self.handoffSegment(handoffID))", method: "DELETE")
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    private static func handoffSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}

// MARK: - The package (plaintext, only ever inside the ECIES message)

/// What one recipient phone decrypts. Encoded byte for byte in the contract's key order (`encoded()`, pinned by tests);
/// amounts are decimal strings so nothing passes through a binary floating point.
public struct RemoteSettingsPackage: Equatable, Sendable {
    public struct Pinned: Codable, Equatable, Sendable {
        public let token_hash: String
        public let bundle_id: String
        public let team_id: String

        public init(token_hash: String, bundle_id: String, team_id: String) {
            self.token_hash = token_hash
            self.bundle_id = bundle_id
            self.team_id = team_id
        }
    }

    public struct Settings: Equatable, Sendable {
        /// Trio: the Shared Secret; Loop: the otpauth:// URL of its QR code.
        public var secret: String
        public var apnsKeyID: String
        public var apnsKeyP8: String
        /// Loop only: the team typed when Nightscout cannot tell it.
        public var teamID: String?
        public var returnKeyID: String?
        public var returnKeyP8: String?
        public var maxBolusUnits: Decimal
        public var maxCarbsGrams: Int
        public var bolusIncrement: Decimal
        /// The Trio / Loop the owner confirmed for this patient.
        public var pinned: Pinned

        public init(secret: String, apnsKeyID: String, apnsKeyP8: String, teamID: String? = nil, returnKeyID: String?, returnKeyP8: String?, maxBolusUnits: Decimal, maxCarbsGrams: Int, bolusIncrement: Decimal, pinned: Pinned) {
            self.secret = secret
            self.apnsKeyID = apnsKeyID
            self.apnsKeyP8 = apnsKeyP8
            self.teamID = teamID
            self.returnKeyID = returnKeyID
            self.returnKeyP8 = returnKeyP8
            self.maxBolusUnits = maxBolusUnits
            self.maxCarbsGrams = maxCarbsGrams
            self.bolusIncrement = bolusIncrement
            self.pinned = pinned
        }
    }

    public static let type = "remote_settings_handoff"

    public let patientID: String
    public let patientName: String
    public let fromUserID: String
    public let fromName: String
    public let fromDeviceID: String
    /// The one phone this copy is for: a package moved to another phone is refused even if it could be decrypted.
    public let toDeviceID: String
    public let loopKind: HandoffLoopKind
    public let createdAt: String
    public let settings: Settings

    public init(patientID: String, patientName: String, fromUserID: String, fromName: String, fromDeviceID: String, toDeviceID: String, loopKind: HandoffLoopKind, createdAt: String, settings: Settings) {
        self.patientID = patientID
        self.patientName = patientName
        self.fromUserID = fromUserID
        self.fromName = fromName
        self.fromDeviceID = fromDeviceID
        self.toDeviceID = toDeviceID
        self.loopKind = loopKind
        self.createdAt = createdAt
        self.settings = settings
    }

    /// The exact UTF-8 JSON bytes that are encrypted (docs/device-auth-api.md §8).
    public func encoded() -> Data {
        let secretKey = loopKind == .trio ? "shared_secret" : "otp_url"
        var fields: [(String, String)] = [
            (secretKey, Self.string(settings.secret)),
            ("apns_key_id", Self.string(settings.apnsKeyID)),
            ("apns_key_p8", Self.string(settings.apnsKeyP8)),
        ]
        if loopKind == .loop { fields.append(("team_id", Self.optional(settings.teamID))) }
        fields += [
            ("return_key_id", Self.optional(settings.returnKeyID)),
            ("return_key_p8", Self.optional(settings.returnKeyP8)),
            ("max_bolus_u", Self.string(Self.decimal(settings.maxBolusUnits))),
            ("max_carbs_g", String(settings.maxCarbsGrams)),
            ("bolus_increment_u", Self.string(Self.decimal(settings.bolusIncrement))),
            ("pinned", Self.object([
                ("token_hash", Self.string(settings.pinned.token_hash)),
                ("bundle_id", Self.string(settings.pinned.bundle_id)),
                ("team_id", Self.string(settings.pinned.team_id)),
            ])),
        ]
        return Data(Self.object([
            ("v", "1"),
            ("type", Self.string(Self.type)),
            ("patient_id", Self.string(patientID)),
            ("patient_name", Self.string(patientName)),
            ("from_user_id", Self.string(fromUserID)),
            ("from_name", Self.string(fromName)),
            ("from_device_id", Self.string(fromDeviceID)),
            ("to_device_id", Self.string(toDeviceID)),
            ("loop_kind", Self.string(loopKind.rawValue)),
            ("created_at", Self.string(createdAt)),
            ("settings", Self.object(fields)),
        ]).utf8)
    }

    /// Reads a decrypted package; anything but a v1 package of this shape is `.malformed`.
    public static func decode(_ data: Data) throws -> RemoteSettingsPackage {
        guard data.count <= 16 * 1024, let wire = try? JSONDecoder().decode(Wire.self, from: data), wire.v == 1, wire.type == type else {
            throw RemoteSettingsHandoffError.malformed
        }
        let secret = wire.loop_kind == .trio ? wire.settings.shared_secret : wire.settings.otp_url
        guard let secret, let maxBolus = parseDecimal(wire.settings.max_bolus_u), let increment = parseDecimal(wire.settings.bolus_increment_u) else {
            throw RemoteSettingsHandoffError.malformed
        }
        return RemoteSettingsPackage(
            patientID: wire.patient_id,
            patientName: wire.patient_name,
            fromUserID: wire.from_user_id,
            fromName: wire.from_name,
            fromDeviceID: wire.from_device_id,
            toDeviceID: wire.to_device_id,
            loopKind: wire.loop_kind,
            createdAt: wire.created_at,
            settings: Settings(
                secret: secret,
                apnsKeyID: wire.settings.apns_key_id,
                apnsKeyP8: wire.settings.apns_key_p8,
                teamID: wire.settings.team_id ?? nil,
                returnKeyID: wire.settings.return_key_id ?? nil,
                returnKeyP8: wire.settings.return_key_p8 ?? nil,
                maxBolusUnits: maxBolus,
                maxCarbsGrams: wire.settings.max_carbs_g,
                bolusIncrement: increment,
                pinned: wire.settings.pinned
            )
        )
    }

    private struct Wire: Decodable {
        struct WireSettings: Decodable {
            let shared_secret: String?
            let otp_url: String?
            let apns_key_id: String
            let apns_key_p8: String
            let team_id: String??
            let return_key_id: String??
            let return_key_p8: String??
            let max_bolus_u: String
            let max_carbs_g: Int
            let bolus_increment_u: String
            let pinned: Pinned
        }
        let v: Int
        let type: String
        let patient_id: String
        let patient_name: String
        let from_user_id: String
        let from_name: String
        let from_device_id: String
        let to_device_id: String
        let loop_kind: HandoffLoopKind
        let created_at: String
        let settings: WireSettings
    }

    static func decimal(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue
    }

    static func parseDecimal(_ value: String) -> Decimal? {
        guard value.range(of: #"^[0-9]+(\.[0-9]+)?$"#, options: .regularExpression) != nil else { return nil }
        return Decimal(string: value, locale: Locale(identifier: "en_US_POSIX"))
    }

    private static func object(_ fields: [(String, String)]) -> String {
        "{" + fields.map { "\(string($0.0)):\($0.1)" }.joined(separator: ",") + "}"
    }

    private static func optional(_ value: String?) -> String {
        value.map(string) ?? "null"
    }

    private static func string(_ value: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return String(decoding: (try? encoder.encode(value)) ?? Data("\"\"".utf8), as: UTF8.self)
    }
}

public enum RemoteSettingsHandoffError: Error, Equatable {
    /// This phone's own settings for the patient are not complete (or its Trio/Loop is not confirmed): nothing to hand.
    case nothingToHandOver
    /// The person has no paired phone the package could go to.
    case noRecipientDevices
    /// The sender's signature does not check out: the package was changed or is not from the owner's phone.
    case signatureInvalid
    /// The package is for another phone or patient (moved, replayed) or says something else than its envelope.
    case wrongRecipient
    /// Could not be decrypted on this phone (another phone's, changed on the way) or is not a package at all.
    case malformed
    /// The secret is already saved for another patient on this phone.
    case secretUsedByOtherPatient
    /// The Trio / Loop is confirmed for another patient on this phone.
    case loopUsedByOtherPatient
    case notPaired
    case cancelled
    case key(DeviceKeyError)
    case storage

    public var message: String {
        switch self {
        case .nothingToHandOver: return "Na tym telefonie nie ma gotowych ustawień zdalnego sterowania dla tego pacjenta. Najpierw ustaw je tutaj (Zdalny bolus → Zdalne sterowanie)."
        case .noRecipientDevices: return "Ta osoba nie ma jeszcze połączonego telefonu."
        case .signatureInvalid: return "Podpis przekazanych ustawień się nie zgadza. Nic nie zostało zapisane. Poproś o przekazanie ich jeszcze raz."
        case .wrongRecipient: return "Te ustawienia są dla innego telefonu albo pacjenta. Nic nie zostało zapisane."
        case .malformed: return "Nie udało się odczytać przekazanych ustawień na tym telefonie. Nic nie zostało zapisane. Poproś o przekazanie ich jeszcze raz."
        case .secretUsedByOtherPatient: return "Ten sekret pętli jest już zapisany na tym telefonie dla innego pacjenta. Nic nie zostało zapisane."
        case .loopUsedByOtherPatient: return "Ta pętla jest na tym telefonie przypisana do innego pacjenta. Nic nie zostało zapisane."
        case .notPaired: return "Ten telefon nie jest połączony z serwerem."
        case .cancelled: return "Anulowano."
        case let .key(error): return error == .cancelled ? "Anulowano." : error.message
        case .storage: return "Nie udało się zapisać w pęku kluczy."
        }
    }
}

// MARK: - Crypto

public enum RemoteSettingsHandoffCrypto {
    /// What the owner's device key signs, the server checks on upload and the recipient checks before decrypting.
    public static func message(patientID: String, fromDeviceID: String, toDeviceID: String, loopKind: HandoffLoopKind, recipientKey: HandoffRecipientKey, ciphertext: String) -> Data {
        Data(["mellis-remote-settings-v1", patientID, fromDeviceID, toDeviceID, loopKind.rawValue, recipientKey.rawValue, ciphertext].joined(separator: "\n").utf8)
    }

    /// One recipient phone's copy: the package naming that phone, encrypted to its key, signed by this phone's device key.
    public static func seal(_ package: RemoteSettingsPackage, for device: HandoffDevice, signer: DeviceSigningKey) async throws -> HandoffPackageBody {
        guard package.toDeviceID == device.device_id, let publicKey = Data(base64Encoded: device.encryption_public_key) else {
            throw RemoteSettingsHandoffError.wrongRecipient
        }
        let ciphertext: Data
        do {
            ciphertext = try DeviceKeyECIES.encrypt(package.encoded(), toPublicKeyX963: publicKey)
        } catch let error as DeviceKeyError {
            throw RemoteSettingsHandoffError.key(error)
        }
        let encoded = ciphertext.base64EncodedString()
        let signed = message(patientID: package.patientID, fromDeviceID: package.fromDeviceID, toDeviceID: device.device_id, loopKind: package.loopKind, recipientKey: device.recipient_key, ciphertext: encoded)
        let signature: Data
        do {
            signature = try await signer.sign(signed, prompt: nil)
        } catch let error as DeviceKeyError {
            throw RemoteSettingsHandoffError.key(error)
        }
        return HandoffPackageBody(to_device_id: device.device_id, recipient_key: device.recipient_key, ciphertext: encoded, sender_signature: signature.base64EncodedString())
    }

    /// Checks and opens a package fetched for this phone: the sender's signature first (nothing is decrypted, no Face
    /// ID asked, for a forged one), then the key it was encrypted to decrypts it, then the package must name this phone,
    /// this patient, the sending phone and the loop of its envelope.
    public static func open(_ consumed: ConsumedHandoff, thisDeviceID: String, keys: DeviceKeyPair, prompt: String) async throws -> RemoteSettingsPackage {
        let handoff = consumed.handoff
        guard handoff.to_device_id.lowercased() == thisDeviceID.lowercased() else { throw RemoteSettingsHandoffError.wrongRecipient }
        let signed = message(patientID: handoff.patient_id, fromDeviceID: handoff.from_device_id, toDeviceID: handoff.to_device_id, loopKind: handoff.loop_kind, recipientKey: handoff.recipient_key, ciphertext: consumed.ciphertext)
        guard let senderKeyData = Data(base64Encoded: handoff.from_device_public_key),
              let senderKey = try? P256.Signing.PublicKey(x963Representation: senderKeyData),
              let signatureData = Data(base64Encoded: consumed.sender_signature),
              let signature = try? P256.Signing.ECDSASignature(derRepresentation: signatureData),
              senderKey.isValidSignature(signature, for: signed)
        else { throw RemoteSettingsHandoffError.signatureInvalid }
        guard let ciphertext = Data(base64Encoded: consumed.ciphertext) else { throw RemoteSettingsHandoffError.malformed }
        let key: DeviceSigningKey
        switch handoff.recipient_key {
        case .bolus:
            guard let bolus = keys.bolus else { throw RemoteSettingsHandoffError.key(.keyUnavailable) }
            key = bolus
        case .device:
            key = keys.device
        }
        let plaintext: Data
        do {
            plaintext = try await key.decrypt(ciphertext, prompt: handoff.recipient_key == .bolus ? prompt : nil)
        } catch DeviceKeyError.cancelled {
            throw RemoteSettingsHandoffError.cancelled
        } catch DeviceKeyError.failed {
            throw RemoteSettingsHandoffError.malformed
        } catch let error as DeviceKeyError {
            throw RemoteSettingsHandoffError.key(error)
        }
        let package = try RemoteSettingsPackage.decode(plaintext)
        guard package.toDeviceID.lowercased() == thisDeviceID.lowercased(),
              package.patientID.lowercased() == handoff.patient_id.lowercased(),
              package.fromDeviceID.lowercased() == handoff.from_device_id.lowercased(),
              package.loopKind == handoff.loop_kind
        else { throw RemoteSettingsHandoffError.wrongRecipient }
        return package
    }
}

// MARK: - From and into this phone's Keychain settings

public extension RemoteSettingsPackage.Settings {
    /// The owner's complete, confirmed Trio settings; nil when there is nothing that would work on another phone.
    init?(trio settings: TrioRemoteSettings, glucoMindTeamID: String) {
        guard settings.isComplete(glucoMindTeamID: glucoMindTeamID), let pinned = settings.pinnedTrio else { return nil }
        self.init(
            secret: settings.sharedSecret,
            apnsKeyID: settings.apnsKeyID,
            apnsKeyP8: settings.apnsKeyP8,
            returnKeyID: settings.returnKeyID,
            returnKeyP8: settings.returnKeyP8,
            maxBolusUnits: settings.maxBolusUnits,
            maxCarbsGrams: settings.maxCarbsGrams,
            bolusIncrement: settings.bolusIncrement,
            pinned: .init(token_hash: pinned.tokenHash, bundle_id: pinned.bundleID, team_id: pinned.teamID)
        )
    }

    init?(loop settings: LoopRemoteSettings, glucoMindTeamID: String) {
        guard settings.isComplete(glucoMindTeamID: glucoMindTeamID), let pinned = settings.pinnedLoop else { return nil }
        self.init(
            secret: settings.otpURL,
            apnsKeyID: settings.apnsKeyID,
            apnsKeyP8: settings.apnsKeyP8,
            teamID: settings.teamID,
            returnKeyID: settings.returnKeyID,
            returnKeyP8: settings.returnKeyP8,
            maxBolusUnits: settings.maxBolusUnits,
            maxCarbsGrams: settings.maxCarbsGrams,
            bolusIncrement: settings.bolusIncrement,
            pinned: .init(token_hash: pinned.tokenHash, bundle_id: pinned.bundleID, team_id: pinned.teamID)
        )
    }
}

/// Saves a received package into this phone's Keychain settings for the patient exactly as if typed there: the same
/// TrioRemoteSettings / LoopRemoteSettings, limits reviewed (the owner's; the person may make them stricter), the
/// owner's confirmed Trio / Loop (Nightscout is compared with it before every command, as for typed settings).
public enum RemoteSettingsHandoffImporter {
    public static func save(_ package: RemoteSettingsPackage, trioStore: TrioRemoteSettingsStore, loopStore: LoopRemoteSettingsStore, scope: RemotePatientScope = .shared, now: Date = Date()) throws {
        let settings = package.settings
        let patientID = package.patientID
        let pinned = settings.pinned
        switch package.loopKind {
        case .trio:
            if TrioPatientGuard.secretUsedByOtherPatient(settings.secret, patientID: patientID, store: trioStore, scope: scope) { throw RemoteSettingsHandoffError.secretUsedByOtherPatient }
            if scope.otherPatientIDs(of: patientID, in: (try? trioStore.patientIDs()) ?? []).contains(where: { ((try? trioStore.load(patientID: $0)) ?? nil)?.pinnedTrio?.tokenHash == pinned.token_hash }) {
                throw RemoteSettingsHandoffError.loopUsedByOtherPatient
            }
            var trio = TrioRemoteSettings(
                sharedSecret: settings.secret.trimmingCharacters(in: .whitespacesAndNewlines),
                apnsKeyID: settings.apnsKeyID,
                apnsKeyP8: settings.apnsKeyP8,
                returnKeyID: settings.returnKeyID,
                returnKeyP8: settings.returnKeyP8,
                maxBolusUnits: settings.maxBolusUnits,
                maxCarbsGrams: settings.maxCarbsGrams,
                bolusIncrement: settings.bolusIncrement,
                pinnedTrio: PinnedTrio(tokenHash: pinned.token_hash, bundleID: pinned.bundle_id, teamID: pinned.team_id, pinnedAt: now)
            )
            trio.limitsReviewed = true
            do { try trioStore.save(trio, patientID: patientID) } catch { throw RemoteSettingsHandoffError.storage }
            NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: patientID)
        case .loop:
            if LoopPatientGuard.secretUsedByOtherPatient(settings.secret, patientID: patientID, store: loopStore, scope: scope) { throw RemoteSettingsHandoffError.secretUsedByOtherPatient }
            if scope.otherPatientIDs(of: patientID, in: (try? loopStore.patientIDs()) ?? []).contains(where: { ((try? loopStore.load(patientID: $0)) ?? nil)?.pinnedLoop?.tokenHash == pinned.token_hash }) {
                throw RemoteSettingsHandoffError.loopUsedByOtherPatient
            }
            var loop = LoopRemoteSettings(
                otpURL: settings.secret.trimmingCharacters(in: .whitespacesAndNewlines),
                apnsKeyID: settings.apnsKeyID,
                apnsKeyP8: settings.apnsKeyP8,
                teamID: settings.teamID,
                returnKeyID: settings.returnKeyID,
                returnKeyP8: settings.returnKeyP8,
                maxBolusUnits: settings.maxBolusUnits,
                maxCarbsGrams: settings.maxCarbsGrams,
                bolusIncrement: settings.bolusIncrement,
                pinnedLoop: PinnedLoop(tokenHash: pinned.token_hash, bundleID: pinned.bundle_id, teamID: pinned.team_id, pinnedAt: now)
            )
            loop.limitsReviewed = true
            do { try loopStore.save(loop, patientID: patientID) } catch { throw RemoteSettingsHandoffError.storage }
            NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: patientID)
        }
    }
}

// MARK: - Owner and recipient flows

/// "Przekaż moje ustawienia Trio/Loop": reads this phone's settings for the patient, the person's phones and their keys,
/// and sends one sealed copy per phone. `confirm` (Face ID, when the phone has it) runs before anything leaves.
public final class RemoteSettingsHandoffSender {
    private let api: RemoteSettingsHandoffAPI
    private let keys: DeviceKeyStore
    private let deviceID: () -> String?
    private let trioStore: TrioRemoteSettingsStore
    private let loopStore: LoopRemoteSettingsStore
    private let glucoMindTeamID: String
    private let confirm: ((String) async -> BiometricResult)?
    private let now: () -> Date

    public init(api: RemoteSettingsHandoffAPI, keys: DeviceKeyStore, deviceID: @escaping () -> String?, trioStore: TrioRemoteSettingsStore, loopStore: LoopRemoteSettingsStore, glucoMindTeamID: String, confirm: ((String) async -> BiometricResult)?, now: @escaping () -> Date = Date.init) {
        self.api = api
        self.keys = keys
        self.deviceID = deviceID
        self.trioStore = trioStore
        self.loopStore = loopStore
        self.glucoMindTeamID = glucoMindTeamID
        self.confirm = confirm
        self.now = now
    }

    /// This phone's complete settings for the patient and loop, ready to hand over; nil when there are none.
    public func handableSettings(patientID: String, loopKind: HandoffLoopKind) -> RemoteSettingsPackage.Settings? {
        switch loopKind {
        case .trio: return ((try? trioStore.load(patientID: patientID)) ?? nil).flatMap { .init(trio: $0, glucoMindTeamID: glucoMindTeamID) }
        case .loop: return ((try? loopStore.load(patientID: patientID)) ?? nil).flatMap { .init(loop: $0, glucoMindTeamID: glucoMindTeamID) }
        }
    }

    public static func confirmation(loopKind: HandoffLoopKind, personName: String, patientName: String) -> String {
        "Przekazać Twoje ustawienia \(loopKind.displayName) dla: \(patientName) osobie \(personName)?"
    }

    /// Returns the number of phones the settings went to.
    @discardableResult
    public func send(patientID: String, patientName: String, fromUserID: String, fromName: String, toUserID: String, toName: String, loopKind: HandoffLoopKind) async throws -> Int {
        guard let settings = handableSettings(patientID: patientID, loopKind: loopKind) else { throw RemoteSettingsHandoffError.nothingToHandOver }
        guard let deviceID = deviceID(), let pair = (try? keys.loadKeys()) ?? nil else { throw RemoteSettingsHandoffError.notPaired }
        let devices = try await api.handoffDevices(patientID: patientID, userID: toUserID).devices.filter { $0.device_id.lowercased() != deviceID.lowercased() }
        guard !devices.isEmpty else { throw RemoteSettingsHandoffError.noRecipientDevices }
        if let confirm {
            switch await confirm(Self.confirmation(loopKind: loopKind, personName: toName, patientName: patientName)) {
            case .confirmed: break
            case let .refused(message):
                throw message == "Anulowano." ? RemoteSettingsHandoffError.cancelled : RemoteSettingsHandoffError.key(.failed(message))
            }
        }
        let createdAt = ServerDate.string(now())
        var packages: [HandoffPackageBody] = []
        for device in devices {
            let package = RemoteSettingsPackage(patientID: patientID, patientName: patientName, fromUserID: fromUserID, fromName: fromName, fromDeviceID: deviceID, toDeviceID: device.device_id, loopKind: loopKind, createdAt: createdAt, settings: settings)
            packages.append(try await RemoteSettingsHandoffCrypto.seal(package, for: device, signer: pair.device))
        }
        return try await api.createHandoff(patientID: patientID, body: HandoffCreateBody(to_user_id: toUserID, loop_kind: loopKind, packages: packages)).handoffs.count
    }
}

/// The recipient: packages waiting for this phone, "Zapisz" (fetch once, Face ID, check, decrypt, save) and "Odrzuć".
@MainActor
public final class RemoteSettingsInboxModel: ObservableObject {
    @Published public private(set) var pending: [RemoteSettingsHandoff] = []
    @Published public private(set) var isWorking = false
    @Published public var errorMessage: String?
    /// "Zapisano ustawienia Trio dla: Zosia": shown once after a save.
    @Published public private(set) var savedNotice: String?

    private let api: RemoteSettingsHandoffAPI
    private let keys: DeviceKeyStore
    private let deviceID: () -> String?
    private let trioStore: TrioRemoteSettingsStore
    private let loopStore: LoopRemoteSettingsStore
    /// A fetched package is single use on the server: kept here (memory only) while Face ID is retried.
    private var fetched: [String: ConsumedHandoff] = [:]

    public init(api: RemoteSettingsHandoffAPI, keys: DeviceKeyStore, deviceID: @escaping () -> String?, trioStore: TrioRemoteSettingsStore, loopStore: LoopRemoteSettingsStore) {
        self.api = api
        self.keys = keys
        self.deviceID = deviceID
        self.trioStore = trioStore
        self.loopStore = loopStore
    }

    public func pending(for patientID: String) -> [RemoteSettingsHandoff] {
        pending.filter { $0.patient_id.lowercased() == patientID.lowercased() }
    }

    public func refresh() async {
        do {
            let listed = try await api.listMyHandoffs()
            // Fetched but not saved yet (Face ID cancelled): still offered from memory.
            let kept = fetched.values.map(\.handoff).filter { held in !listed.contains { $0.handoff_id == held.handoff_id } }
            pending = listed + kept
        } catch {
            if error.isRequestCancellation { return }
        }
    }

    public static func prompt(_ handoff: RemoteSettingsHandoff) -> String {
        "Zapisać ustawienia \(handoff.loop_kind.displayName) dla: \(handoff.patient_name) od: \(handoff.from_name)?"
    }

    /// "Zapisz": true when saved.
    @discardableResult
    public func save(_ handoff: RemoteSettingsHandoff) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            guard let deviceID = deviceID(), let pair = (try? keys.loadKeys()) ?? nil else { throw RemoteSettingsHandoffError.notPaired }
            let consumed: ConsumedHandoff
            if let held = fetched[handoff.handoff_id] {
                consumed = held
            } else {
                consumed = try await api.consumeHandoff(handoffID: handoff.handoff_id)
                fetched[handoff.handoff_id] = consumed
            }
            let package = try await RemoteSettingsHandoffCrypto.open(consumed, thisDeviceID: deviceID, keys: pair, prompt: Self.prompt(handoff))
            try RemoteSettingsHandoffImporter.save(package, trioStore: trioStore, loopStore: loopStore)
            fetched[handoff.handoff_id] = nil
            pending.removeAll { $0.handoff_id == handoff.handoff_id }
            savedNotice = "Zapisano ustawienia \(handoff.loop_kind.displayName) dla: \(handoff.patient_name) od: \(handoff.from_name)."
            errorMessage = nil
            return true
        } catch RemoteSettingsHandoffError.cancelled {
            return false
        } catch let error as RemoteSettingsHandoffError {
            if error != .cancelled && error != .key(.cancelled) {
                errorMessage = error.message
                // A package that cannot be opened here never will: it is dropped (the owner sends it again).
                if [.signatureInvalid, .wrongRecipient, .malformed].contains(error) { drop(handoff) }
            }
            return false
        } catch let error as APIClientError where error.problemCode == "HANDOFF_NOT_FOUND" {
            errorMessage = "Tych ustawień już nie ma na serwerze (wygasły, zostały cofnięte albo zapisane na innym telefonie)."
            drop(handoff)
            return false
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się pobrać ustawień."
            return false
        }
    }

    /// "Odrzuć": deleted on the server (or, when already fetched, only here).
    public func reject(_ handoff: RemoteSettingsHandoff) async {
        isWorking = true
        defer { isWorking = false }
        if fetched[handoff.handoff_id] == nil {
            do {
                try await api.rejectHandoff(handoffID: handoff.handoff_id)
            } catch let error as APIClientError where error.problemCode == "HANDOFF_NOT_FOUND" {
                // Gone already.
            } catch {
                errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się odrzucić ustawień."
                return
            }
        }
        drop(handoff)
    }

    public func dismissNotice() {
        savedNotice = nil
    }

    private func drop(_ handoff: RemoteSettingsHandoff) {
        fetched[handoff.handoff_id] = nil
        pending.removeAll { $0.handoff_id == handoff.handoff_id }
    }
}
