import Foundation

// Device auth (AUTH_MODE=device, docs/device-auth-api.md): a self-hosted server without accounts or e-mail.
// The phone pairs once with a one-time code from a QR / link and from then on proves itself with its own Secure
// Enclave keys. Keys of the server's JSON are snake_case, as everywhere in the app.

/// One-time codes (pairing, invitation, recovery): Crockford base32 groups such as "7KQ2M-9XH4T-…". The server ignores
/// case, spaces and dashes and reads O as 0, I and L as 1; signatures cover the normalized form.
public enum OneTimeCode {
    public static func normalize(_ raw: String) -> String {
        let upper = raw.uppercased()
            .replacingOccurrences(of: "O", with: "0")
            .replacingOccurrences(of: "I", with: "1")
            .replacingOccurrences(of: "L", with: "1")
        let kept = upper.unicodeScalars.filter { ("0"..."9").contains($0) || ("A"..."Z").contains($0) }
        return String(String.UnicodeScalarView(kept).prefix(64))
    }

    /// Long enough to be a code at all (the server refuses shorter ones without looking).
    public static func isPlausible(_ raw: String) -> Bool {
        normalize(raw).count >= 16
    }
}

/// The exact bytes each signature covers (`modules/device-auth/domain/device-crypto.ts`): any change here breaks pairing,
/// sessions or remote commands, so tests pin them byte for byte.
public enum DeviceAuthMessage {
    /// What the device key signs when a phone pairs (or recovers with the recovery code instead of a pairing code). No
    /// bolus key at pairing (v2): a phone without Face ID pairs too.
    public static func pairing(code: String, publicKey: String) -> Data {
        Data(["mellis-pair-v2", OneTimeCode.normalize(code), publicKey].joined(separator: "\n").utf8)
    }

    /// What both the device key and the new bolus key sign when this phone registers its bolus key.
    public static func bolusKey(deviceID: String, challengeID: String, nonce: String, bolusPublicKey: String) -> Data {
        Data(["mellis-bolus-key-v1", deviceID, challengeID, nonce, bolusPublicKey].joined(separator: "\n").utf8)
    }

    /// What the device key signs for a session token.
    public static func session(deviceID: String, challengeID: String, nonce: String) -> Data {
        Data(["mellis-session-v1", deviceID, challengeID, nonce].joined(separator: "\n").utf8)
    }

    /// A remote command as the person confirmed it, signed by the bolus key (Face ID). The server reads these exact JSON
    /// bytes and never re-serialises them; the key order is the contract's, for readable records.
    public static func remoteCommand(challenge: SigningChallenge, deviceID: String, insulinU: Decimal, carbsG: Int, confirmation: String) -> Data {
        json([
            ("v", "1"),
            ("type", string("remote_command")),
            ("challenge_id", string(challenge.challenge_id)),
            ("nonce", string(challenge.nonce)),
            ("device_id", string(deviceID)),
            ("patient_id", string(challenge.patient_id)),
            ("patient_name", string(challenge.patient_name)),
            ("insulin_u", number(insulinU)),
            ("carbs_g", String(carbsG)),
            ("confirmation", string(confirmation)),
        ])
    }

    /// The grantee's own "Chcę podawać bolus zdalnie" for one patient, signed by the bolus key.
    /// `diyAcknowledgedAt` (the DIY acknowledgement accepted on this phone) goes last, as ISO 8601 UTC; older servers
    /// ignore it, newer ones record it in the grant's audit.
    public static func remoteBolusConfirm(challenge: SigningChallenge, deviceID: String, confirmation: String, diyAcknowledgedAt: Date? = nil) -> Data {
        var fields: [(String, String)] = [
            ("v", "1"),
            ("type", string("remote_bolus_confirm")),
            ("challenge_id", string(challenge.challenge_id)),
            ("nonce", string(challenge.nonce)),
            ("device_id", string(deviceID)),
            ("patient_id", string(challenge.patient_id)),
            ("patient_name", string(challenge.patient_name)),
            ("confirmation", string(confirmation)),
        ]
        if let diyAcknowledgedAt { fields.append(("diy_acknowledged_at", string(ServerDate.string(diyAcknowledgedAt)))) }
        return json(fields)
    }

    /// The question the person answers with Face ID: the app's usual "Janek: podać 30 g węglowodanów i 2,5 j
    /// insuliny?" (the name as stored, no declension, as the Bolus tab's "dla: Janek").
    public static func remoteCommandConfirmation(patientName: String, insulinU: Decimal, carbsG: Int) -> String {
        var parts: [String] = []
        if carbsG > 0 { parts.append("\(carbsG) g węglowodanów") }
        if insulinU > 0 { parts.append("\(RemoteCommandFormat.units(insulinU)) j insuliny") }
        return "\(patientName): podać \(parts.joined(separator: " i "))?"
    }

    public static func remoteBolusConfirmation(patientName: String) -> String {
        "Chcę podawać bolus zdalnie dla: \(patientName)"
    }

    private static func json(_ fields: [(String, String)]) -> Data {
        Data(("{" + fields.map { "\(string($0.0)):\($0.1)" }.joined(separator: ",") + "}").utf8)
    }

    private static func string(_ value: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        // Encoding a String cannot fail.
        return String(decoding: (try? encoder.encode(value)) ?? Data("\"\"".utf8), as: UTF8.self)
    }

    /// "2.5", "0", "10": a JSON number as the server compares it (±0.001).
    private static func number(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue
    }
}

public extension Data {
    /// base64url without padding (RFC 4648 §5), what the server reads with Buffer.from(…, 'base64url').
    func base64URLEncodedStringWithoutPadding() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - Requests and answers

public struct NewDeviceBody: Encodable, Equatable {
    public let name: String
    public let public_key: String
    /// The id this app already registers push tokens under (POST /v1/patients/:id/devices): revoking the device stops
    /// those push rows too.
    public let client_device_id: String?
}

public struct PairRequestBody: Encodable, Equatable {
    public let code: String
    public let first_name: String?
    public let device: NewDeviceBody
    public let signature: String
}

public struct RecoverRequestBody: Encodable, Equatable {
    public let recovery_code: String
    public let device: NewDeviceBody
    public let signature: String
}

/// POST /v1/me/devices/bolus-key: both keys sign DeviceAuthMessage.bolusKey over a BOLUS_KEY challenge.
public struct BolusKeyRegisterBody: Encodable, Equatable {
    public let challenge_id: String
    public let bolus_public_key: String
    public let signature: String
    public let bolus_signature: String
}

public struct BolusKeyRegistration: Decodable, Equatable {
    public let device_id: String
    public let bolus_key_registered_at: String

    public init(device_id: String, bolus_key_registered_at: String) {
        self.device_id = device_id
        self.bolus_key_registered_at = bolus_key_registered_at
    }
}

public struct DeviceSessionView: Codable, Equatable {
    public let access_token: String
    public let token_type: String
    public let expires_at: String

    public init(access_token: String, token_type: String = "Bearer", expires_at: String) {
        self.access_token = access_token
        self.token_type = token_type
        self.expires_at = expires_at
    }
}

public struct PairedUser: Codable, Equatable {
    public let user_id: String
    public let display_name: String?
}

/// POST /v1/pair and POST /v1/setup/recover (with a new recovery code).
public struct PairResponse: Decodable, Equatable {
    public let device_id: String
    public let user: PairedUser
    public let patients: [AccessiblePatient]
    public let session: DeviceSessionView
    /// Recovery only: the new code, shown once (the old one stops working).
    public let recovery_code: String?
}

public struct SessionChallenge: Decodable, Equatable {
    public let challenge_id: String
    public let nonce: String
    public let expires_at: String
}

/// POST /v1/patients/:id/signing-challenges: the nonce the bolus key signs, with the patient's name as stored.
public struct SigningChallenge: Decodable, Equatable {
    public let challenge_id: String
    public let nonce: String
    public let expires_at: String
    public let patient_id: String
    public let patient_name: String

    public init(challenge_id: String, nonce: String, expires_at: String, patient_id: String, patient_name: String) {
        self.challenge_id = challenge_id
        self.nonce = nonce
        self.expires_at = expires_at
        self.patient_id = patient_id
        self.patient_name = patient_name
    }
}

public enum SigningPurpose: String, Encodable {
    case remoteBolus = "REMOTE_BOLUS"
    case remoteBolusConfirm = "REMOTE_BOLUS_CONFIRM"
}

/// `device_authorization` of a remote command (and of the grantee's confirmation): the exact signed bytes (base64url)
/// and the bolus key's DER signature (base64).
public struct DeviceAuthorizationEnvelope: Codable, Equatable {
    public let payload: String
    public let signature: String

    public init(payload: String, signature: String) {
        self.payload = payload
        self.signature = signature
    }

    public init(signedBytes: Data, signature: Data) {
        self.init(payload: signedBytes.base64URLEncodedStringWithoutPadding(), signature: signature.base64EncodedString())
    }
}

/// A paired phone (GET /v1/me/devices, and an owner's view of a person's phones).
public struct PairedDevice: Codable, Equatable, Identifiable {
    public let device_id: String
    public let user_id: String
    public let name: String
    public let created_at: String
    public let last_seen_at: String?
    public let this_device: Bool
    /// The phone registered its bolus key (absent on servers before step 1).
    public var has_bolus_key: Bool? = nil

    public var id: String { device_id }
}

public struct PairedDevicesResponse: Decodable, Equatable {
    public let devices: [PairedDevice]
}

/// A one-time code with its QR link: another phone of the same person (10 min), an invitation (7 days).
public struct PairingCode: Codable, Equatable {
    public let code: String
    public let expires_at: String
    public let pairing_url: String
}

/// What a person may do for a patient (sharing permissions of migration 090).
public struct SharingPermissions: Codable, Equatable, Sendable {
    /// "Glukoza i alarmy": the dashboard, glucose alerts, Live Activities.
    public var glucose_alerts: Bool
    /// "Rozmowy z AI i posiłki": conversations, meals, reminders and every other push.
    public var ai_chat_meals: Bool
    /// "Zarządza udostępnianiem" = owner (co-owner).
    public var manage_sharing: Bool
    /// "Zdalny bolus": granted by an owner, counts only after the person's signed confirmation.
    public var remote_commands: Bool

    public init(glucose_alerts: Bool = true, ai_chat_meals: Bool = true, manage_sharing: Bool = false, remote_commands: Bool = false) {
        self.glucose_alerts = glucose_alerts
        self.ai_chat_meals = ai_chat_meals
        self.manage_sharing = manage_sharing
        self.remote_commands = remote_commands
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        glucose_alerts = (try container.decodeIfPresent(Bool.self, forKey: .glucose_alerts)) ?? false
        ai_chat_meals = (try container.decodeIfPresent(Bool.self, forKey: .ai_chat_meals)) ?? false
        manage_sharing = (try container.decodeIfPresent(Bool.self, forKey: .manage_sharing)) ?? false
        remote_commands = (try container.decodeIfPresent(Bool.self, forKey: .remote_commands)) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case glucose_alerts, ai_chat_meals, manage_sharing, remote_commands
    }

    /// "Zaproś osobę" starts with glucose and AI on, the rest off.
    public static let inviteDefaults = SharingPermissions()

    /// A co-owner always has glucose and AI (the server enforces it).
    public var locksOtherSwitches: Bool { manage_sharing }

    /// Remote bolus works only with "Rozmowy z AI i posiłki".
    public var allowsRemoteBolus: Bool { ai_chat_meals || manage_sharing }

    /// What is saved, as the server enforces it: a co-owner has glucose and AI on; no remote bolus without AI.
    public var normalized: SharingPermissions {
        var result = self
        if result.manage_sharing {
            result.glucose_alerts = true
            result.ai_chat_meals = true
        }
        if !result.ai_chat_meals { result.remote_commands = false }
        return result
    }

    /// Nothing on: the server refuses it (INVALID_PERMISSIONS).
    public var isEmpty: Bool { !(glucose_alerts || ai_chat_meals || manage_sharing) }

    public static let coOwnerNote = "Pełny współwłaściciel: widzi wszystko (glukoza, rozmowy z AI i posiłki), zaprasza, zmienia uprawnienia, odłącza telefony i włącza zdalny bolus. Dlatego glukoza i rozmowy z AI są zawsze włączone."

    /// The short line under a person: "Glukoza i alarmy · Rozmowy z AI i posiłki · Zdalny bolus".
    public func summary(remoteBolus: RemoteBolusGrantState? = nil) -> String {
        var parts: [String] = []
        if glucose_alerts { parts.append("Glukoza i alarmy") }
        if ai_chat_meals { parts.append("Rozmowy z AI i posiłki") }
        if manage_sharing { parts.append("Zarządza udostępnianiem") }
        switch remoteBolus {
        case .some(.awaitingConfirmation): parts.append("Zdalny bolus czeka na potwierdzenie")
        case .some(.on): parts.append("Zdalny bolus")
        case .some(.off): break
        case .none: if remote_commands { parts.append("Zdalny bolus") }
        }
        return parts.isEmpty ? "Bez uprawnień" : parts.joined(separator: " · ")
    }
}

public enum RemoteBolusGrantState: Equatable {
    case off
    /// Granted by an owner, not confirmed on the person's phone yet.
    case awaitingConfirmation
    case on
}

public struct RemoteBolusGrant: Codable, Equatable {
    public let granted_by: String?
    public let granted_at: String?
    public let confirmed_at: String?
    public let effective: Bool

    public init(granted_by: String? = nil, granted_at: String? = nil, confirmed_at: String? = nil, effective: Bool = false) {
        self.granted_by = granted_by
        self.granted_at = granted_at
        self.confirmed_at = confirmed_at
        self.effective = effective
    }

    public var state: RemoteBolusGrantState {
        if effective { return .on }
        return granted_at != nil && confirmed_at == nil ? .awaitingConfirmation : .off
    }
}

/// A person of a patient (GET /v1/patients/:id/people). `permissions.remote_commands` is the effective grant.
public struct PatientPerson: Codable, Equatable, Identifiable {
    public let user_id: String
    public let display_name: String
    public let is_owner: Bool
    public let permissions: SharingPermissions
    public let remote_bolus: RemoteBolusGrant
    public var is_you: Bool?
    /// Owners only.
    public var devices: [PairedDevice]?

    public var id: String { user_id }
    public var isYou: Bool { is_you == true }

    /// The switches as an owner edits them: remote bolus on while granted (confirmed or not).
    public var editablePermissions: SharingPermissions {
        var result = permissions
        result.manage_sharing = is_owner
        result.remote_commands = remote_bolus.state != .off
        return result
    }
}

public struct OpenInvitation: Codable, Equatable, Identifiable {
    public let invitation_id: String
    public let first_name: String?
    public let permissions: SharingPermissions
    public let created_at: String
    public let expires_at: String

    public var id: String { invitation_id }
    public var title: String { first_name?.isEmpty == false ? first_name! : "Zaproszenie" }
}

public struct PatientPeopleResponse: Decodable, Equatable {
    public let patient_id: String
    public let you_are_owner: Bool
    public let people: [PatientPerson]
    public let invitations: [OpenInvitation]

    /// At most 10 people per patient, open invitations included.
    public static let maxPeople = 10
    public var peopleCount: Int { people.count + invitations.count }
    public var isFull: Bool { peopleCount >= Self.maxPeople }
    public var you: PatientPerson? { people.first(where: \.isYou) }

    /// Owners first, then by name; "Ty" first of all.
    public var sortedPeople: [PatientPerson] {
        people.sorted { lhs, rhs in
            if lhs.isYou != rhs.isYou { return lhs.isYou }
            if lhs.is_owner != rhs.is_owner { return lhs.is_owner }
            return lhs.display_name.localizedCaseInsensitiveCompare(rhs.display_name) == .orderedAscending
        }
    }
}

public struct InvitationCreateBody: Encodable, Equatable {
    public let first_name: String
    public let permissions: SharingPermissions
}

public struct InvitationCreateResponse: Decodable, Equatable {
    public let invitation: OpenInvitation
    public let pairing: PairingCode
}

public struct PersonUpdateResponse: Decodable, Equatable {
    public let member: PatientPerson
}

public struct InvitationAcceptResponse: Decodable, Equatable {
    public let patient_id: String
    public let member: PatientPerson?
}

/// "Dodaj pacjenta" (POST /v1/patients): the same body as the setup's first patient.
public struct NewPatientBody: Encodable, Equatable {
    public struct NightscoutAccess: Encodable, Equatable {
        public let url: String
        public let token: String
    }

    public let display_name: String
    public let birth_year: Int
    public let nightscout: NightscoutAccess
    /// "Dodaj też współwłaścicieli": owners of the caller's other patients who own the new one too.
    public let co_owner_user_ids: [String]?

    public init(displayName: String, birthYear: Int, nightscoutURL: String, token: String, coOwnerUserIDs: [String] = []) {
        display_name = displayName
        birth_year = birthYear
        nightscout = NightscoutAccess(url: nightscoutURL, token: token)
        co_owner_user_ids = coOwnerUserIDs.isEmpty ? nil : coOwnerUserIDs
    }
}

/// GET /v1/me/co-owners: the owners of the caller's patients (not the caller), with the patients they own.
public struct CoOwnerCandidate: Codable, Equatable, Identifiable {
    public struct OwnedPatient: Codable, Equatable {
        public let patient_id: String
        public let display_name: String

        public init(patient_id: String, display_name: String) {
            self.patient_id = patient_id
            self.display_name = display_name
        }
    }

    public let user_id: String
    public let display_name: String
    public let patients: [OwnedPatient]

    public var id: String { user_id }

    public init(user_id: String, display_name: String, patients: [OwnedPatient]) {
        self.user_id = user_id
        self.display_name = display_name
        self.patients = patients
    }

    /// "Współwłaściciel: Zosia, Kuba".
    public var detail: String {
        "Współwłaściciel: " + patients.map(\.display_name).joined(separator: ", ")
    }
}

public struct CoOwnerCandidatesResponse: Codable, Equatable {
    public let people: [CoOwnerCandidate]
}

/// GET /v1/patients/:id/nightscout: the patient's Nightscout address and newest reading (Settings).
public struct NightscoutSummary: Codable, Equatable {
    public let patient_id: String
    public let base_url: String?
    public let last_reading_at: String?

    public init(patient_id: String, base_url: String?, last_reading_at: String?) {
        self.patient_id = patient_id
        self.base_url = base_url
        self.last_reading_at = last_reading_at
    }

    public var host: String? { base_url.flatMap { URL(string: $0)?.host } ?? base_url }
}

public struct NewPatientResponse: Decodable, Equatable {
    public struct Created: Decodable, Equatable {
        public let patient_id: String
        public let display_name: String
        public let birth_year: Int?
    }

    public let patient: Created
}

/// Polish texts for the device-auth error codes the person can do something about.
public enum DeviceAuthErrorText {
    public static func message(for error: Error) -> String? {
        guard let apiError = error as? APIClientError else { return nil }
        let problem: ProblemDetails?
        switch apiError {
        case let .unauthenticated(details), let .forbidden(details), let .notFound(details), let .conflict(details),
             let .validation(details), let .server(details), let .unexpectedStatus(_, details):
            problem = details
        case .transport:
            return "Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie."
        case .invalidResponse:
            return nil
        }
        switch problem?.code {
        case "PAIRING_CODE_INVALID": return "Kod nieprawidłowy albo wygasł. Poproś o nowy kod."
        case "RECOVERY_CODE_INVALID": return "Kod odzyskiwania jest nieprawidłowy."
        case "PAIRING_SIGNATURE_INVALID", "PUBLIC_KEY_INVALID": return "Nie udało się przygotować kluczy tego telefonu. Spróbuj ponownie."
        case "DEVICE_ALREADY_PAIRED": return "Ten telefon jest już połączony. Spróbuj ponownie."
        case "PEOPLE_LIMIT_REACHED": return "Osiągnięto limit \(PatientPeopleResponse.maxPeople) osób (razem z zaproszeniami)."
        case "INVALID_PERMISSIONS": return "Włącz co najmniej glukozę albo rozmowy z AI. Zdalny bolus wymaga rozmów z AI."
        case "NOT_AN_OWNER": return "To może zrobić tylko właściciel."
        case "LAST_OWNER": return "Pacjent musi mieć co najmniej jednego właściciela."
        case "ALREADY_A_MEMBER": return "Masz już dostęp do tego pacjenta."
        case "REMOTE_BOLUS_NOT_GRANTED": return "Właściciel nie włączył Ci zdalnego bolusa."
        case "REMOTE_COMMAND_SIGNATURE_INVALID", "REMOTE_COMMAND_SIGNATURE_REQUIRED": return "Serwer nie przyjął podpisu tego telefonu. Nic nie zostało wysłane."
        case "BOLUS_KEY_REQUIRED": return RemoteBolusKeyText.missing
        case "BOLUS_KEY_SIGNATURE_INVALID": return "Serwer nie przyjął klucza do bolusa tego telefonu. Spróbuj ponownie."
        case "REMOTE_BOLUS_NOT_PERMITTED": return "Zdalny bolus nie jest włączony i potwierdzony dla Ciebie u tego pacjenta. Nic nie zostało wysłane."
        case "CO_OWNER_NOT_ALLOWED": return "Współwłaścicielem może zostać tylko właściciel innego Twojego pacjenta."
        case "NIGHTSCOUT_ADDRESS_INVALID": return "Adres Nightscouta jest nieprawidłowy."
        case "NIGHTSCOUT_HOST_NOT_ALLOWED": return "Serwer nie pozwala łączyć się z tym adresem Nightscouta."
        case "NIGHTSCOUT_UNREACHABLE": return "Nie udało się połączyć z Nightscoutem. Sprawdź, czy adres otwiera się w przeglądarce."
        case "NIGHTSCOUT_TOKEN_MISSING": return "Podaj token Nightscouta tylko do odczytu."
        case "NIGHTSCOUT_TOKEN_INVALID": return "Nightscout nie przyjął tego tokenu."
        case "NIGHTSCOUT_TOKEN_ADMIN", "NIGHTSCOUT_TOKEN_NOT_READ_ONLY": return "Ten token ma prawo zapisu. Utwórz w Nightscoucie token z rolą readable."
        case "NIGHTSCOUT_NO_RECENT_READINGS": return "W Nightscoucie nie ma odczytu glukozy z ostatnich 24 godzin."
        case "NIGHTSCOUT_ALREADY_USED": return "Ten Nightscout jest już połączony z innym pacjentem."
        default: return nil
        }
    }
}

public enum RemoteBolusKeyText {
    /// The server or this phone has no bolus key: the person sets it up in the patient's settings.
    public static let missing = "Ten telefon nie ma jeszcze klucza do zdalnego bolusa. Ustaw go: Ustawienia → pacjent → Zdalny bolus → Ustaw na tym telefonie (Face ID). Nic nie zostało wysłane."
}

public extension SharingPermissions {
    /// The switches that differ from `old`, by their server keys.
    func changes(from old: SharingPermissions) -> [String: Bool] {
        var result: [String: Bool] = [:]
        if glucose_alerts != old.glucose_alerts { result["glucose_alerts"] = glucose_alerts }
        if ai_chat_meals != old.ai_chat_meals { result["ai_chat_meals"] = ai_chat_meals }
        if manage_sharing != old.manage_sharing { result["manage_sharing"] = manage_sharing }
        if remote_commands != old.remote_commands { result["remote_commands"] = remote_commands }
        return result
    }
}
