import Foundation
import CryptoKit

public struct CognitoOAuthConfiguration: Equatable {
    public let domainURL: URL
    public let clientID: String
    public let redirectURI: URL
    public let scopes: [String]

    public init(domainURL: URL, clientID: String, redirectURI: URL, scopes: [String]) {
        self.domainURL = domainURL
        self.clientID = clientID
        self.redirectURI = redirectURI
        self.scopes = scopes
    }

    public var callbackScheme: String? {
        redirectURI.scheme
    }
}

public struct OAuthTokenSet: Codable, Equatable {
    public let accessToken: String
    public let refreshToken: String
    public let idToken: String?
    public let expiresAt: Date

    public init(accessToken: String, refreshToken: String, idToken: String?, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
        self.expiresAt = expiresAt
    }
}

public struct OAuthAuthorizationCode {
    public let code: String
    public let state: String
    public let codeVerifier: String

    public init(code: String, state: String, codeVerifier: String) {
        self.code = code
        self.state = state
        self.codeVerifier = codeVerifier
    }
}

public protocol OAuthTokenStore {
    func load() throws -> OAuthTokenSet?
    func save(_ tokenSet: OAuthTokenSet) throws
    func clear() throws
}

public protocol AuthorizationCodeFlow {
    func authorize(requestURL: URL, callbackScheme: String) async throws -> URL
}

public protocol Clock {
    var now: Date { get }
}

public struct SystemClock: Clock {
    public init() {}

    public var now: Date {
        Date()
    }
}

public protocol CognitoOAuthClientProtocol {
    func startAuthorization() async throws -> OAuthAuthorizationCode
    func exchangeCode(_ authorization: OAuthAuthorizationCode) async throws -> OAuthTokenSet
    func refresh(refreshToken: String) async throws -> OAuthTokenSet
}

public struct CognitoOAuthClient: CognitoOAuthClientProtocol {
    private struct TokenResponse: Decodable {
        let access_token: String
        let refresh_token: String?
        let id_token: String?
        let expires_in: Int
    }

    private let config: CognitoOAuthConfiguration
    private let authorizationFlow: AuthorizationCodeFlow
    private let httpClient: HTTPClient
    private let clock: Clock

    public init(
        config: CognitoOAuthConfiguration,
        authorizationFlow: AuthorizationCodeFlow,
        httpClient: HTTPClient,
        clock: Clock = SystemClock()
    ) {
        self.config = config
        self.authorizationFlow = authorizationFlow
        self.httpClient = httpClient
        self.clock = clock
    }

    public func startAuthorization() async throws -> OAuthAuthorizationCode {
        guard let callbackScheme = config.callbackScheme else {
            throw APIClientError.invalidResponse
        }

        let codeVerifier = Self.randomURLSafeString(length: 64)
        let codeChallenge = Self.codeChallenge(from: codeVerifier)
        let state = Self.randomURLSafeString(length: 32)

        guard let url = authorizationURL(state: state, codeChallenge: codeChallenge) else {
            throw APIClientError.invalidResponse
        }

        let callbackURL = try await authorizationFlow.authorize(
            requestURL: url,
            callbackScheme: callbackScheme
        )

        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems,
              let returnedState = queryItems.first(where: { $0.name == "state" })?.value,
              returnedState == state,
              let code = queryItems.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            throw APIClientError.unauthenticated(nil)
        }

        return OAuthAuthorizationCode(code: code, state: state, codeVerifier: codeVerifier)
    }

    public func exchangeCode(_ authorization: OAuthAuthorizationCode) async throws -> OAuthTokenSet {
        let body = [
            "grant_type": "authorization_code",
            "client_id": config.clientID,
            "code": authorization.code,
            "redirect_uri": config.redirectURI.absoluteString,
            "code_verifier": authorization.codeVerifier,
        ]

        let response = try await requestToken(body: body)
        guard let refreshToken = response.refresh_token, !refreshToken.isEmpty else {
            throw APIClientError.unauthenticated(nil)
        }

        return tokenSet(from: response, refreshTokenFallback: refreshToken)
    }

    public func refresh(refreshToken: String) async throws -> OAuthTokenSet {
        let body = [
            "grant_type": "refresh_token",
            "client_id": config.clientID,
            "refresh_token": refreshToken,
        ]

        let response = try await requestToken(body: body)
        return tokenSet(from: response, refreshTokenFallback: refreshToken)
    }

    private func requestToken(body: [String: String]) async throws -> TokenResponse {
        let tokenURL = config.domainURL.appending(path: "/oauth2/token")
        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Self.formURLEncoded(body)

        do {
            let (data, response) = try await httpClient.perform(request)
            // 400/401 (invalid_grant, revoked or expired refresh token): the session is really over. Anything else
            // (throttling, 5xx) is temporary and must not sign the caregiver out.
            if response.statusCode == 400 || response.statusCode == 401 {
                throw APIClientError.unauthenticated(nil)
            }
            guard (200...299).contains(response.statusCode) else {
                throw APIClientError.transport("token endpoint HTTP \(response.statusCode)")
            }
            return try JSONDecoder().decode(TokenResponse.self, from: data)
        } catch let error as APIClientError {
            throw error
        } catch {
            throw APIClientError.transport(String(describing: error))
        }
    }

    private func tokenSet(from response: TokenResponse, refreshTokenFallback: String) -> OAuthTokenSet {
        let expiry = clock.now.addingTimeInterval(TimeInterval(response.expires_in))
        return OAuthTokenSet(
            accessToken: response.access_token,
            refreshToken: response.refresh_token ?? refreshTokenFallback,
            idToken: response.id_token,
            expiresAt: expiry
        )
    }

    private func authorizationURL(state: String, codeChallenge: String) -> URL? {
        var components = URLComponents(url: config.domainURL.appending(path: "/oauth2/authorize"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: config.clientID),
            URLQueryItem(name: "redirect_uri", value: config.redirectURI.absoluteString),
            URLQueryItem(name: "scope", value: config.scopes.joined(separator: " ")),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "state", value: state),
        ]
        return components?.url
    }

    private static func formURLEncoded(_ values: [String: String]) -> Data {
        let body = values
            .map { key, value in
                "\(percentEncode(key))=\(percentEncode(value))"
            }
            .sorted()
            .joined(separator: "&")

        return Data(body.utf8)
    }

    private static func percentEncode(_ value: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: ":#[]@!$&'()*+,;=")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private static func codeChallenge(from verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64URLEncodedString()
    }

    private static func randomURLSafeString(length: Int) -> String {
        let bytes = (0..<length).map { _ in UInt8.random(in: 0...255) }
        return Data(bytes).base64URLEncodedString()
            .replacingOccurrences(of: "=", with: "")
            .prefix(length)
            .description
    }
}

public actor CognitoAuthProvider: SessionAuthProvider {
    private let oauthClient: CognitoOAuthClientProtocol
    private let tokenStore: OAuthTokenStore
    private let clock: Clock
    private let refreshSkew: TimeInterval

    private var cachedTokenSet: OAuthTokenSet?
    /// One refresh at a time: opening the app from a notification restores the session, handles the push and loads
    /// several screens at once, and they all wait for the same refresh instead of racing with one refresh token.
    private var refreshTask: Task<OAuthTokenSet, Error>?
    /// Grows on every sign-in and sign-out: a refresh that finishes after the session it started in ended writes nothing.
    private var sessionGeneration = 0
    /// Told when the session ends without the caregiver signing out (the refresh token was rejected).
    private var sessionEndedHandler: (@Sendable () -> Void)?

    public init(
        oauthClient: CognitoOAuthClientProtocol,
        tokenStore: OAuthTokenStore,
        clock: Clock = SystemClock(),
        refreshSkew: TimeInterval = 60
    ) {
        self.oauthClient = oauthClient
        self.tokenStore = tokenStore
        self.clock = clock
        self.refreshSkew = refreshSkew
    }

    /// True while a session exists. A temporary failure (no network right after waking up, Keychain not readable
    /// yet, token endpoint 5xx) keeps the session; only a rejected refresh token ends it.
    public func restoreSession() async -> Bool {
        if cachedTokenSet == nil {
            do {
                cachedTokenSet = try tokenStore.load()
            } catch {
                return true
            }
        }

        guard cachedTokenSet != nil else {
            return false
        }

        do {
            _ = try await validTokenSet()
            return true
        } catch APIClientError.unauthenticated {
            return false
        } catch {
            return true
        }
    }

    /// Called (on the provider's executor) when the session ends on its own, e.g. a rejected refresh token while the
    /// app is open, so the app can show the sign-in screen. Not called for `signOut()`.
    public func setSessionEndedHandler(_ handler: (@Sendable () -> Void)?) {
        sessionEndedHandler = handler
    }

    public func signIn() async throws {
        let authorization = try await oauthClient.startAuthorization()
        let tokenSet = try await oauthClient.exchangeCode(authorization)
        cancelRefresh()
        sessionGeneration += 1
        cachedTokenSet = tokenSet
        try tokenStore.save(tokenSet)
    }

    public func signOut() async {
        clearSession()
    }

    /// Throws `unauthenticated` only when the session is over; a temporary failure throws `transport` and keeps it.
    public func bearerToken() async throws -> String {
        try await validTokenSet().accessToken
    }

    private func validTokenSet() async throws -> OAuthTokenSet {
        if cachedTokenSet == nil {
            do {
                cachedTokenSet = try tokenStore.load()
            } catch {
                throw APIClientError.transport("token store unavailable")
            }
        }

        guard let tokenSet = cachedTokenSet else {
            throw APIClientError.unauthenticated(nil)
        }

        if tokenSet.expiresAt > clock.now.addingTimeInterval(refreshSkew) {
            return tokenSet
        }

        let generation = sessionGeneration
        let task: Task<OAuthTokenSet, Error>
        if let inFlight = refreshTask {
            task = inFlight
        } else {
            let oauthClient = self.oauthClient
            let refreshToken = tokenSet.refreshToken
            task = Task { try await oauthClient.refresh(refreshToken: refreshToken) }
            refreshTask = task
        }

        let result: Result<OAuthTokenSet, Error>
        do {
            result = .success(try await task.value)
        } catch {
            result = .failure(error)
        }
        let isFirstWaiter = refreshTask == task
        if isFirstWaiter {
            refreshTask = nil
        }

        guard generation == sessionGeneration else {
            // Signed out (or in again) while the refresh ran: its tokens or its failure belong to the old session.
            return try await validTokenSet()
        }

        switch result {
        case .success(let refreshed):
            if isFirstWaiter {
                cachedTokenSet = refreshed
                try? tokenStore.save(refreshed)
            }
            return refreshed
        case .failure(APIClientError.unauthenticated):
            clearSession()
            sessionEndedHandler?()
            throw APIClientError.unauthenticated(nil)
        case .failure(let error):
            throw error as? APIClientError ?? APIClientError.transport(String(describing: error))
        }
    }

    private func cancelRefresh() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    private func clearSession() {
        cancelRefresh()
        sessionGeneration += 1
        cachedTokenSet = nil
        try? tokenStore.clear()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        self.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
