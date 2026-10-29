import Foundation

/// The device-auth routes behind a session (docs/device-auth-api.md §4–6): own phones, people of a patient,
/// invitations, signing challenges and the remote bolus confirmation.
public protocol DeviceSharingAPI {
    func listOwnDevices() async throws -> [PairedDevice]
    func revokeOwnDevice(deviceID: String) async throws
    func createOwnPairingCode() async throws -> PairingCode
    func acceptInvitation(code: String) async throws -> InvitationAcceptResponse
    func listPeople(patientID: String) async throws -> PatientPeopleResponse
    func createInvitation(patientID: String, firstName: String, permissions: SharingPermissions) async throws -> InvitationCreateResponse
    func revokeInvitation(patientID: String, invitationID: String) async throws
    func updatePerson(patientID: String, userID: String, changes: [String: Bool]) async throws -> PatientPerson
    func removePerson(patientID: String, userID: String) async throws
    func revokeMemberDevice(patientID: String, userID: String, deviceID: String) async throws
    func confirmRemoteBolus(patientID: String, authorization: DeviceAuthorizationEnvelope) async throws -> PatientPerson
    func createPatient(_ body: NewPatientBody) async throws -> NewPatientResponse
    /// "Dodaj też współwłaścicieli" (GET /v1/me/co-owners).
    func listCoOwnerCandidates() async throws -> [CoOwnerCandidate]
    /// Settings → the patient's page (GET /v1/patients/:id/nightscout).
    func nightscoutSummary(patientID: String) async throws -> NightscoutSummary
}

public protocol SigningChallengeAPI {
    func createSigningChallenge(patientID: String, purpose: SigningPurpose) async throws -> SigningChallenge
    /// POST /v1/me/devices/bolus-key/challenge
    func createBolusKeyChallenge() async throws -> SessionChallenge
    /// POST /v1/me/devices/bolus-key
    func registerBolusKey(_ body: BolusKeyRegisterBody) async throws -> BolusKeyRegistration
}

extension APIClient: DeviceSharingAPI, SigningChallengeAPI {
    public func listOwnDevices() async throws -> [PairedDevice] {
        let request = try await makeRequest(path: "/v1/me/devices", method: "GET")
        return try await decode(request, as: PairedDevicesResponse.self).devices
    }

    public func revokeOwnDevice(deviceID: String) async throws {
        let request = try await makeRequest(path: "/v1/me/devices/\(Self.pathSegment(deviceID))", method: "DELETE")
        try await send(request)
    }

    public func createOwnPairingCode() async throws -> PairingCode {
        let request = try await makeRequest(path: "/v1/me/pairing-codes", method: "POST")
        return try await decode(request, as: PairingCode.self)
    }

    public func acceptInvitation(code: String) async throws -> InvitationAcceptResponse {
        try await decode(jsonRequest(path: "/v1/me/invitations/accept", method: "POST", body: ["code": code]), as: InvitationAcceptResponse.self)
    }

    public func listPeople(patientID: String) async throws -> PatientPeopleResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/people", method: "GET")
        return try await decode(request, as: PatientPeopleResponse.self)
    }

    public func createInvitation(patientID: String, firstName: String, permissions: SharingPermissions) async throws -> InvitationCreateResponse {
        try await decode(
            jsonRequest(path: "/v1/patients/\(patientID)/invitations", method: "POST", body: InvitationCreateBody(first_name: firstName, permissions: permissions)),
            as: InvitationCreateResponse.self
        )
    }

    public func revokeInvitation(patientID: String, invitationID: String) async throws {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/invitations/\(Self.pathSegment(invitationID))", method: "DELETE")
        try await send(request)
    }

    /// Only the switches that changed: `remote_commands: true` is a new grant (the person confirms it again), so an
    /// unchanged grant is never sent.
    public func updatePerson(patientID: String, userID: String, changes: [String: Bool]) async throws -> PatientPerson {
        try await decode(
            jsonRequest(path: "/v1/patients/\(patientID)/people/\(Self.pathSegment(userID))", method: "PUT", body: ["permissions": changes]),
            as: PersonUpdateResponse.self
        ).member
    }

    public func removePerson(patientID: String, userID: String) async throws {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/people/\(Self.pathSegment(userID))", method: "DELETE")
        try await send(request)
    }

    public func revokeMemberDevice(patientID: String, userID: String, deviceID: String) async throws {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/people/\(Self.pathSegment(userID))/devices/\(Self.pathSegment(deviceID))", method: "DELETE")
        try await send(request)
    }

    public func confirmRemoteBolus(patientID: String, authorization: DeviceAuthorizationEnvelope) async throws -> PatientPerson {
        try await decode(
            jsonRequest(path: "/v1/patients/\(patientID)/remote-bolus/confirm", method: "POST", body: ["device_authorization": authorization]),
            as: PersonUpdateResponse.self
        ).member
    }

    public func createPatient(_ body: NewPatientBody) async throws -> NewPatientResponse {
        var request = try await jsonRequest(path: "/v1/patients", method: "POST", body: body)
        // The server tests the Nightscout before saving (token exchange, a recent reading).
        request.timeoutInterval = 40
        return try await decode(request, as: NewPatientResponse.self)
    }

    public func createSigningChallenge(patientID: String, purpose: SigningPurpose) async throws -> SigningChallenge {
        try await decode(jsonRequest(path: "/v1/patients/\(patientID)/signing-challenges", method: "POST", body: ["purpose": purpose]), as: SigningChallenge.self)
    }

    public func createBolusKeyChallenge() async throws -> SessionChallenge {
        let request = try await makeRequest(path: "/v1/me/devices/bolus-key/challenge", method: "POST")
        return try await decode(request, as: SessionChallenge.self)
    }

    public func registerBolusKey(_ body: BolusKeyRegisterBody) async throws -> BolusKeyRegistration {
        try await decode(jsonRequest(path: "/v1/me/devices/bolus-key", method: "POST", body: body), as: BolusKeyRegistration.self)
    }

    public func listCoOwnerCandidates() async throws -> [CoOwnerCandidate] {
        let request = try await makeRequest(path: "/v1/me/co-owners", method: "GET")
        return try await decode(request, as: CoOwnerCandidatesResponse.self).people
    }

    public func nightscoutSummary(patientID: String) async throws -> NightscoutSummary {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/nightscout", method: "GET")
        return try await decode(request, as: NightscoutSummary.self)
    }

    private func jsonRequest<Body: Encodable>(path: String, method: String, body: Body) async throws -> URLRequest {
        var request = try await makeRequest(path: path, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try jsonEncoder.encode(body)
        return request
    }

    private func send(_ request: URLRequest) async throws {
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }

    private static func pathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}

// MARK: - Signing remote commands

/// Signs what the person confirmed with the bolus key (Face ID enforced by the key): every remote command, and the
/// grantee's confirmation of a remote bolus grant. Device mode only; a Cognito build has none and keeps its own
/// Face ID check.
public protocol RemoteCommandSigning: AnyObject {
    /// The confirmation opened: a challenge is fetched now, so signing does not wait for it.
    func prepare(patientID: String) async
    func signRemoteCommand(patientID: String, insulinU: Decimal, carbsG: Int) async throws -> SignedRemoteCommand
    func signRemoteBolusConfirm(patientID: String) async throws -> SignedRemoteCommand
}

public struct SignedRemoteCommand: Equatable {
    public let authorization: DeviceAuthorizationEnvelope
    /// What the person answered with Face ID.
    public let confirmation: String
    /// The signed bytes (tests and logs; the envelope carries them base64url).
    public let payload: Data
}

public enum RemoteCommandSigningError: Error, Equatable {
    case notPaired
    /// This phone has no bolus key (or the server has none registered for it): set it up in the patient's settings
    /// (Zdalny bolus → Ustaw na tym telefonie), which runs signRemoteBolusConfirm.
    case bolusKeyMissing
    case challengeFailed(String)
    case key(DeviceKeyError)

    public var message: String {
        switch self {
        case .notPaired: return "Ten telefon nie jest połączony z serwerem. Nic nie zostało wysłane."
        case .bolusKeyMissing: return RemoteBolusKeyText.missing
        case let .challengeFailed(detail): return detail
        case let .key(error): return error == .cancelled ? "Anulowano." : error.message
        }
    }
}

public final class DeviceRemoteCommandSigner: RemoteCommandSigning, @unchecked Sendable {
    private let api: SigningChallengeAPI
    private let deviceID: () -> String?
    private let keys: DeviceKeyStore
    private let now: () -> Date
    private let lock = NSLock()
    /// At most one prefetched challenge per patient and purpose; used once, then dropped (a challenge is single use,
    /// and a 409 REMOTE_COMMAND_WARNINGS_CHANGED has used it up as well).
    private var prefetched: [String: SigningChallenge] = [:]
    /// A prefetched challenge is used only with this much of its 2 minutes left.
    static let minimumValidity: TimeInterval = 30

    public init(api: SigningChallengeAPI, deviceID: @escaping () -> String?, keys: DeviceKeyStore, now: @escaping () -> Date = Date.init) {
        self.api = api
        self.deviceID = deviceID
        self.keys = keys
        self.now = now
    }

    public func prepare(patientID: String) async {
        guard let challenge = try? await api.createSigningChallenge(patientID: patientID, purpose: .remoteBolus) else { return }
        lock.withLock { prefetched[key(patientID, .remoteBolus)] = challenge }
    }

    public func signRemoteCommand(patientID: String, insulinU: Decimal, carbsG: Int) async throws -> SignedRemoteCommand {
        let (deviceID, keyPair) = try identity()
        guard let bolusKey = keyPair.bolus else { throw RemoteCommandSigningError.bolusKeyMissing }
        let challenge = try await challenge(patientID: patientID, purpose: .remoteBolus)
        let confirmation = DeviceAuthMessage.remoteCommandConfirmation(patientName: challenge.patient_name, insulinU: insulinU, carbsG: carbsG)
        let payload = DeviceAuthMessage.remoteCommand(challenge: challenge, deviceID: deviceID, insulinU: insulinU, carbsG: carbsG, confirmation: confirmation)
        do {
            return try await sign(payload, confirmation: confirmation, key: bolusKey)
        } catch RemoteCommandSigningError.key(.keyUnavailable) {
            // Face ID changed: the key is gone for good; a new one comes with the next confirmation.
            keys.deleteBolusKey()
            throw RemoteCommandSigningError.key(.keyUnavailable)
        }
    }

    /// "Chcę podawać bolus zdalnie dla: Zosia" (also "Ustaw na tym telefonie" for a confirmed grant): a bolus key for
    /// this phone (a new one when it has none, or its old one stopped working), registered with the server, and the
    /// confirmation payload, both signed under one Face ID. The caller sends the result to remote-bolus/confirm.
    /// Without Face ID / Touch ID: `.key(.biometryNotAvailable)`, nothing is created.
    public func signRemoteBolusConfirm(patientID: String) async throws -> SignedRemoteCommand {
        do {
            return try await registerAndSignConfirm(patientID: patientID)
        } catch RemoteCommandSigningError.key(.keyUnavailable) {
            keys.deleteBolusKey()
            return try await registerAndSignConfirm(patientID: patientID)
        }
    }

    private func registerAndSignConfirm(patientID: String) async throws -> SignedRemoteCommand {
        let (deviceID, keyPair) = try identity()
        let bolusKey: DeviceSigningKey
        if let existing = keyPair.bolus {
            bolusKey = existing
        } else {
            do {
                bolusKey = try keys.createBolusKey()
            } catch let error as DeviceKeyError {
                throw RemoteCommandSigningError.key(error)
            } catch {
                throw RemoteCommandSigningError.key(.failed(String(describing: error)))
            }
        }
        let challenge = try await challenge(patientID: patientID, purpose: .remoteBolusConfirm)
        let keyChallenge: SessionChallenge
        do {
            keyChallenge = try await api.createBolusKeyChallenge()
        } catch {
            throw RemoteCommandSigningError.challengeFailed(DeviceAuthErrorText.message(for: error) ?? "Nie udało się przygotować klucza do bolusa.")
        }
        let confirmation = DeviceAuthMessage.remoteBolusConfirmation(patientName: challenge.patient_name)
        let payload = DeviceAuthMessage.remoteBolusConfirm(challenge: challenge, deviceID: deviceID, confirmation: confirmation)
        let registration = DeviceAuthMessage.bolusKey(deviceID: deviceID, challengeID: keyChallenge.challenge_id, nonce: keyChallenge.nonce, bolusPublicKey: bolusKey.publicKeyBase64)
        let signatures: [Data]
        do {
            // One Face ID: the registration's proof of possession and the confirmation itself.
            signatures = try await bolusKey.sign([registration, payload], prompt: confirmation)
        } catch let error as DeviceKeyError {
            throw RemoteCommandSigningError.key(error)
        } catch {
            throw RemoteCommandSigningError.key(.failed(String(describing: error)))
        }
        let deviceSignature: Data
        do {
            deviceSignature = try await keyPair.device.sign(registration, prompt: nil)
        } catch {
            throw RemoteCommandSigningError.key(.failed(String(describing: error)))
        }
        do {
            _ = try await api.registerBolusKey(BolusKeyRegisterBody(
                challenge_id: keyChallenge.challenge_id,
                bolus_public_key: bolusKey.publicKeyBase64,
                signature: deviceSignature.base64EncodedString(),
                bolus_signature: signatures[0].base64EncodedString()
            ))
        } catch {
            throw RemoteCommandSigningError.challengeFailed(DeviceAuthErrorText.message(for: error) ?? "Serwer nie przyjął klucza do bolusa. Spróbuj ponownie.")
        }
        return SignedRemoteCommand(authorization: DeviceAuthorizationEnvelope(signedBytes: payload, signature: signatures[1]), confirmation: confirmation, payload: payload)
    }

    private func identity() throws -> (String, DeviceKeyPair) {
        guard let deviceID = deviceID(), let keyPair = (try? keys.loadKeys()) ?? nil else {
            throw RemoteCommandSigningError.notPaired
        }
        return (deviceID, keyPair)
    }

    private func challenge(patientID: String, purpose: SigningPurpose) async throws -> SigningChallenge {
        let cacheKey = key(patientID, purpose)
        let cached: SigningChallenge? = lock.withLock { prefetched.removeValue(forKey: cacheKey) }
        if let cached, cached.patient_id.lowercased() == patientID.lowercased(),
           let expiresAt = ServerDate.parse(cached.expires_at), expiresAt.timeIntervalSince(now()) > Self.minimumValidity {
            return cached
        }
        do {
            let fresh = try await api.createSigningChallenge(patientID: patientID, purpose: purpose)
            guard fresh.patient_id.lowercased() == patientID.lowercased() else {
                throw RemoteCommandSigningError.challengeFailed("Serwer podał innego pacjenta. Nic nie zostało wysłane.")
            }
            return fresh
        } catch let error as RemoteCommandSigningError {
            throw error
        } catch let error as APIClientError where error.problemCode == "BOLUS_KEY_REQUIRED" {
            throw RemoteCommandSigningError.bolusKeyMissing
        } catch {
            throw RemoteCommandSigningError.challengeFailed(error.remoteCommandRefusal ?? DeviceAuthErrorText.message(for: error) ?? "Nie udało się przygotować podpisu. Nic nie zostało wysłane.")
        }
    }

    private func sign(_ payload: Data, confirmation: String, key: DeviceSigningKey) async throws -> SignedRemoteCommand {
        let signature: Data
        do {
            signature = try await key.sign(payload, prompt: confirmation)
        } catch let error as DeviceKeyError {
            throw RemoteCommandSigningError.key(error)
        } catch {
            throw RemoteCommandSigningError.key(.failed(String(describing: error)))
        }
        return SignedRemoteCommand(authorization: DeviceAuthorizationEnvelope(signedBytes: payload, signature: signature), confirmation: confirmation, payload: payload)
    }

    private func key(_ patientID: String, _ purpose: SigningPurpose) -> String {
        "\(patientID.lowercased())|\(purpose.rawValue)"
    }
}
