import Foundation

/// The public device-auth routes (no session): pairing, recovery and the session challenge.
public protocol DeviceAuthTransport: Sendable {
    func pair(server: URL, body: PairRequestBody) async throws -> PairResponse
    func recover(server: URL, body: RecoverRequestBody) async throws -> PairResponse
    func sessionChallenge(server: URL, deviceID: String) async throws -> SessionChallenge
    func createSession(server: URL, deviceID: String, challengeID: String, signature: String) async throws -> DeviceSessionView
}

public struct HTTPDeviceAuthTransport: DeviceAuthTransport, @unchecked Sendable {
    private let httpClient: HTTPClient

    public init(httpClient: HTTPClient = URLSessionHTTPClient()) {
        self.httpClient = httpClient
    }

    public func pair(server: URL, body: PairRequestBody) async throws -> PairResponse {
        try await post(server, "/v1/pair", body: body)
    }

    public func recover(server: URL, body: RecoverRequestBody) async throws -> PairResponse {
        try await post(server, "/v1/setup/recover", body: body)
    }

    public func sessionChallenge(server: URL, deviceID: String) async throws -> SessionChallenge {
        try await post(server, "/v1/auth/challenge", body: ["device_id": deviceID])
    }

    public func createSession(server: URL, deviceID: String, challengeID: String, signature: String) async throws -> DeviceSessionView {
        try await post(server, "/v1/auth/session", body: ["device_id": deviceID, "challenge_id": challengeID, "signature": signature])
    }

    private func post<Body: Encodable, Response: Decodable>(_ server: URL, _ path: String, body: Body) async throws -> Response {
        guard let url = URL(string: server.absoluteString + path) else { throw APIClientError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await httpClient.perform(request)
        } catch let error as APIClientError {
            throw error
        } catch {
            if error.isRequestCancellation { throw error }
            throw APIClientError.transport(String(describing: error))
        }
        if let error = APIClient.error(status: response.statusCode, body: data) { throw error }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw APIClientError.invalidResponse
        }
    }
}

/// The session of a paired phone (AUTH_MODE=device): a 15-minute bearer token obtained by signing a server challenge
/// with the device key (no Face ID). Renewed one minute before it expires, or at once when a request gets a 401
/// (`DeviceSessionHTTPClient`). A server that no longer knows the device (revoked, `DEVICE_NOT_PAIRED`) ends the
/// pairing: the app shows the pairing screen again.
public actor DeviceAuthProvider: SessionAuthProvider {
    private let store: DevicePairingStore
    private let keys: DeviceKeyStore
    private let transport: DeviceAuthTransport
    private let clock: Clock
    private let renewalSkew: TimeInterval
    /// False in the widget: it never forgets the pairing or deletes the keys (only the app goes back to pairing).
    private let forgetsUnpairedDevice: Bool

    private var cachedSession: DeviceSessionToken?
    private var renewalTask: Task<DeviceSessionToken, Error>?
    /// Grows on every pairing and unpairing: a renewal that finishes after its pairing ended writes nothing.
    private var generation = 0
    private var sessionEndedHandler: (@Sendable () -> Void)?

    public init(store: DevicePairingStore, keys: DeviceKeyStore, transport: DeviceAuthTransport, clock: Clock = SystemClock(), renewalSkew: TimeInterval = 60, forgetsUnpairedDevice: Bool = true) {
        self.forgetsUnpairedDevice = forgetsUnpairedDevice
        self.store = store
        self.keys = keys
        self.transport = transport
        self.clock = clock
        self.renewalSkew = renewalSkew
    }

    /// The stored pairing (server and device id); nil: the pairing screen.
    public func pairing() -> DevicePairing? {
        try? store.loadPairing()
    }

    /// Called when the pairing ends on its own (the server revoked the device), not for `signOut()`.
    public func setSessionEndedHandler(_ handler: (@Sendable () -> Void)?) {
        sessionEndedHandler = handler
    }

    /// True while this phone is paired. A temporary failure (offline, server down, Keychain locked) keeps the pairing;
    /// only the server saying the device is gone ends it.
    public func restoreSession() async -> Bool {
        let stored: DevicePairing?
        do {
            stored = try store.loadPairing()
        } catch {
            return true
        }
        guard stored != nil else { return false }
        do {
            _ = try await validSession()
            return true
        } catch APIClientError.unauthenticated {
            return false
        } catch {
            return true
        }
    }

    /// Pairing happens on the pairing screen (`pair(link:…)`), never as a sign-in.
    public func signIn() async throws {
        throw APIClientError.unauthenticated(nil)
    }

    /// Forgets the pairing on this phone (keys included). The server's device row is revoked separately ("Odłącz").
    public func signOut() async {
        endPairing()
    }

    public func bearerToken() async throws -> String {
        try await validSession().accessToken
    }

    /// A request was refused with this token (401): the next one starts a new session.
    public func invalidate(token: String) {
        if cachedSession?.accessToken == token || (try? store.loadSession())?.accessToken == token {
            cachedSession = nil
            store.clearSession()
        }
    }

    // MARK: Pairing

    /// Pairs this phone with the server of `link` (setup, invitation, another phone of the same person, reset-owner):
    /// a new device key signs the pairing message, then the server's first session. No Face ID: the bolus key comes
    /// with the first remote bolus confirmation (DeviceRemoteCommandSigner.signRemoteBolusConfirm).
    public func pair(link: PairingLink, deviceName: String, clientDeviceID: String?, firstName: String? = nil) async throws -> PairResponse {
        let created = try keys.createKeys()
        let device = NewDeviceBody(name: deviceName, public_key: created.device.publicKeyBase64, client_device_id: clientDeviceID)
        let message = DeviceAuthMessage.pairing(code: link.code, publicKey: device.public_key)
        let body = PairRequestBody(
            code: link.code,
            first_name: firstName,
            device: device,
            signature: try await created.device.sign(message, prompt: nil).base64EncodedString()
        )
        let response = try await transport.pair(server: link.serverURL, body: body)
        try adopt(response, server: link.serverURL)
        return response
    }

    /// "Mam kod odzyskiwania": pairs a new phone into the first owner; the answer carries a new recovery code.
    public func recover(server: URL, recoveryCode: String, deviceName: String, clientDeviceID: String?) async throws -> PairResponse {
        let created = try keys.createKeys()
        let device = NewDeviceBody(name: deviceName, public_key: created.device.publicKeyBase64, client_device_id: clientDeviceID)
        let message = DeviceAuthMessage.pairing(code: recoveryCode, publicKey: device.public_key)
        let body = RecoverRequestBody(
            recovery_code: recoveryCode,
            device: device,
            signature: try await created.device.sign(message, prompt: nil).base64EncodedString()
        )
        let response = try await transport.recover(server: server, body: body)
        try adopt(response, server: server)
        return response
    }

    private func adopt(_ response: PairResponse, server: URL) throws {
        cancelRenewal()
        generation += 1
        let pairing = DevicePairing(serverURL: server, deviceID: response.device_id, userID: response.user.user_id, displayName: response.user.display_name, pairedAt: clock.now)
        try store.savePairing(pairing)
        if let session = Self.token(response.session) {
            cachedSession = session
            try? store.saveSession(session)
        }
    }

    // MARK: Sessions

    private func validSession() async throws -> DeviceSessionToken {
        if cachedSession == nil {
            cachedSession = try? store.loadSession()
        }
        if let session = cachedSession, session.expiresAt > clock.now.addingTimeInterval(renewalSkew) {
            return session
        }

        let started = generation
        let task: Task<DeviceSessionToken, Error>
        if let inFlight = renewalTask {
            task = inFlight
        } else {
            let pairing: DevicePairing?
            let keyPair: DeviceKeyPair?
            do {
                pairing = try store.loadPairing()
                keyPair = try keys.loadKeys()
            } catch {
                throw APIClientError.transport("keychain unavailable")
            }
            guard let pairing else { throw APIClientError.unauthenticated(nil) }
            guard let keyPair else {
                // The keys are gone (a restored backup, a reset Keychain): this pairing can never sign again.
                endPairing()
                sessionEndedHandler?()
                throw APIClientError.unauthenticated(nil)
            }
            let transport = transport
            let clock = clock
            task = Task {
                try await Self.renew(pairing: pairing, key: keyPair.device, transport: transport, clock: clock)
            }
            renewalTask = task
        }

        let result: Result<DeviceSessionToken, Error>
        do {
            result = .success(try await task.value)
        } catch {
            result = .failure(error)
        }
        let isFirstWaiter = renewalTask == task
        if isFirstWaiter { renewalTask = nil }

        guard started == generation else {
            // Paired again (or unpaired) while the renewal ran: its result belongs to the old pairing.
            return try await validSession()
        }

        switch result {
        case let .success(session):
            if isFirstWaiter {
                cachedSession = session
                try? store.saveSession(session)
            }
            return session
        case let .failure(error):
            if case let APIClientError.unauthenticated(problem) = error {
                if problem?.code == "DEVICE_NOT_PAIRED" || problem?.code == "DEVICE_AUTH_FAILED" {
                    endPairing()
                    sessionEndedHandler?()
                }
                throw APIClientError.unauthenticated(problem)
            }
            throw error as? APIClientError ?? APIClientError.transport(String(describing: error))
        }
    }

    /// Challenge + the device key's signature; a refused signature (the challenge was used up meanwhile) is tried once
    /// more with a new challenge.
    private static func renew(pairing: DevicePairing, key: DeviceSigningKey, transport: DeviceAuthTransport, clock: Clock) async throws -> DeviceSessionToken {
        var attempt = 0
        while true {
            attempt += 1
            let challenge = try await transport.sessionChallenge(server: pairing.serverURL, deviceID: pairing.deviceID)
            let message = DeviceAuthMessage.session(deviceID: pairing.deviceID, challengeID: challenge.challenge_id, nonce: challenge.nonce)
            let signature: Data
            do {
                signature = try await key.sign(message, prompt: nil)
            } catch {
                throw APIClientError.transport("device key: \(error)")
            }
            do {
                let view = try await transport.createSession(server: pairing.serverURL, deviceID: pairing.deviceID, challengeID: challenge.challenge_id, signature: signature.base64EncodedString())
                guard let token = token(view) else { throw APIClientError.invalidResponse }
                return token
            } catch let APIClientError.unauthenticated(problem) where problem?.code == "DEVICE_AUTH_FAILED" && attempt < 2 {
                continue
            }
        }
    }

    private static func token(_ view: DeviceSessionView) -> DeviceSessionToken? {
        guard !view.access_token.isEmpty, let expiresAt = ServerDate.parse(view.expires_at) else { return nil }
        return DeviceSessionToken(accessToken: view.access_token, expiresAt: expiresAt)
    }

    private func cancelRenewal() {
        renewalTask?.cancel()
        renewalTask = nil
    }

    private func endPairing() {
        cancelRenewal()
        generation += 1
        cachedSession = nil
        store.clearSession()
        guard forgetsUnpairedDevice else { return }
        store.clear()
        keys.deleteKeys()
    }
}

/// Retries a request refused with 401 once, with a new session: a token the server dropped (restart, revoked session)
/// renews at once instead of failing the screen. Requests without a bearer token pass through unchanged.
public struct DeviceSessionHTTPClient: HTTPClient {
    private let base: HTTPClient
    private let provider: DeviceAuthProvider

    public init(base: HTTPClient, provider: DeviceAuthProvider) {
        self.base = base
        self.provider = provider
    }

    public func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await base.perform(request)
        guard response.statusCode == 401,
              let header = request.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Bearer ") else {
            return (data, response)
        }
        await provider.invalidate(token: String(header.dropFirst("Bearer ".count)))
        let fresh: String
        do {
            fresh = try await provider.bearerToken()
        } catch {
            return (data, response)
        }
        var retried = request
        retried.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
        return try await base.perform(retried)
    }
}
