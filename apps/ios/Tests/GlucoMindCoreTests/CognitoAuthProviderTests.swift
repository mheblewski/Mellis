import XCTest
@testable import GlucoMindCore

final class CognitoAuthProviderTests: XCTestCase {
    func testLoginStoresTokensAndReturnsBearerToken() async throws {
        let store = InMemoryTokenStore()
        let oauth = StubCognitoOAuthClient()
        oauth.nextAuthorizationCode = OAuthAuthorizationCode(code: "code-1", state: "state-1", codeVerifier: "verifier-1")
        oauth.nextExchangeResult = OAuthTokenSet(
            accessToken: "access-1",
            refreshToken: "refresh-1",
            idToken: "id-1",
            expiresAt: Date(timeIntervalSince1970: 10_000)
        )

        let provider = CognitoAuthProvider(oauthClient: oauth, tokenStore: store, clock: FixedClock(now: Date(timeIntervalSince1970: 1_000)))

        try await provider.signIn()
        let token = try await provider.bearerToken()
        let restored = await provider.restoreSession()

        XCTAssertEqual(token, "access-1")
        XCTAssertEqual(try store.load()?.refreshToken, "refresh-1")
        XCTAssertTrue(restored)
    }

    func testAuthenticatedAppLaunchRestoresPersistedSession() async {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "access-existing",
            refreshToken: "refresh-existing",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 10_000)
        ))

        let provider = CognitoAuthProvider(
            oauthClient: StubCognitoOAuthClient(),
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        let restored = await provider.restoreSession()
        let token = try? await provider.bearerToken()

        XCTAssertTrue(restored)
        XCTAssertEqual(token, "access-existing")
    }

    func testTokenRestorationAcrossMultipleAppLaunches() async {
        let seed = OAuthTokenSet(
            accessToken: "access-persisted",
            refreshToken: "refresh-persisted",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 10_000)
        )
        let store = InMemoryTokenStore(seed: seed)

        let firstLaunch = CognitoAuthProvider(
            oauthClient: StubCognitoOAuthClient(),
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        let firstRestored = await firstLaunch.restoreSession()
        XCTAssertTrue(firstRestored)

        let secondLaunch = CognitoAuthProvider(
            oauthClient: StubCognitoOAuthClient(),
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_100))
        )

        let secondRestored = await secondLaunch.restoreSession()
        let restoredToken = try? await secondLaunch.bearerToken()
        XCTAssertTrue(secondRestored)
        XCTAssertEqual(restoredToken, "access-persisted")
    }

    func testRefreshesTokenWhenExpired() async throws {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "expired-access",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        ))

        let oauth = StubCognitoOAuthClient()
        oauth.nextRefreshResult = OAuthTokenSet(
            accessToken: "access-refreshed",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 10_000)
        )

        let provider = CognitoAuthProvider(
            oauthClient: oauth,
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        let token = try await provider.bearerToken()

        XCTAssertEqual(token, "access-refreshed")
        XCTAssertEqual(oauth.refreshCalls, 1)
    }

    func testExpiredAccessTokenRefreshFailureClearsSession() async {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "expired-access",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        ))

        let oauth = StubCognitoOAuthClient()
        // Cognito rejects the refresh token (invalid_grant): the session is over.
        oauth.refreshError = APIClientError.unauthenticated(nil)

        let provider = CognitoAuthProvider(
            oauthClient: oauth,
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        do {
            _ = try await provider.bearerToken()
            XCTFail("Expected unauthenticated error")
        } catch APIClientError.unauthenticated {
            let restored = await provider.restoreSession()
            XCTAssertFalse(restored)
            XCTAssertNil(try? store.load())
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testNetworkFailureDuringRefreshKeepsSession() async {
        let seed = OAuthTokenSet(
            accessToken: "expiring-access",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        )
        let store = InMemoryTokenStore(seed: seed)

        let oauth = StubCognitoOAuthClient()
        oauth.refreshError = APIClientError.transport("offline")

        let provider = CognitoAuthProvider(
            oauthClient: oauth,
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        // Opening the app from a notification right after it wakes up: no network yet.
        let restored = await provider.restoreSession()
        XCTAssertTrue(restored)
        XCTAssertEqual(try? store.load(), seed)

        do {
            _ = try await provider.bearerToken()
            XCTFail("Expected a transport error")
        } catch APIClientError.transport {
            XCTAssertEqual(try? store.load(), seed)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        // Network back: the same refresh token still works.
        oauth.refreshError = nil
        let token = try? await provider.bearerToken()
        XCTAssertEqual(token, "access-refreshed")
    }

    func testUnreadableKeychainDoesNotSignOut() async {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "access",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 10_000)
        ))
        store.loadError = APIClientError.invalidResponse

        let provider = CognitoAuthProvider(
            oauthClient: StubCognitoOAuthClient(),
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        let restored = await provider.restoreSession()
        XCTAssertTrue(restored)
        store.loadError = nil
        let token = try? await provider.bearerToken()
        XCTAssertEqual(token, "access")
    }

    func testConcurrentRequestsShareOneRefresh() async throws {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "expired-access",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        ))
        let oauth = StubCognitoOAuthClient()
        oauth.refreshDelayNanoseconds = 50_000_000

        let provider = CognitoAuthProvider(
            oauthClient: oauth,
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        async let restored = provider.restoreSession()
        async let first = provider.bearerToken()
        async let second = provider.bearerToken()
        async let third = provider.bearerToken()
        let tokens = try await [first, second, third]

        let restoredValue = await restored
        XCTAssertTrue(restoredValue)
        XCTAssertEqual(tokens, ["access-refreshed", "access-refreshed", "access-refreshed"])
        XCTAssertEqual(oauth.refreshCalls, 1)
    }

    func testLogoutClearsSession() async {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "access-existing",
            refreshToken: "refresh-existing",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 10_000)
        ))

        let provider = CognitoAuthProvider(
            oauthClient: StubCognitoOAuthClient(),
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        await provider.signOut()

        let restored = await provider.restoreSession()
        XCTAssertFalse(restored)
        XCTAssertNil(try? store.load())
    }

    func testReLoginAfterLogoutCreatesNewSession() async throws {
        let store = InMemoryTokenStore()
        let oauth = StubCognitoOAuthClient()
        oauth.nextAuthorizationCode = OAuthAuthorizationCode(code: "code-1", state: "state-1", codeVerifier: "verifier-1")
        oauth.nextExchangeResult = OAuthTokenSet(
            accessToken: "access-1",
            refreshToken: "refresh-1",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 10_000)
        )

        let provider = CognitoAuthProvider(
            oauthClient: oauth,
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        try await provider.signIn()
        await provider.signOut()

        oauth.nextAuthorizationCode = OAuthAuthorizationCode(code: "code-2", state: "state-2", codeVerifier: "verifier-2")
        oauth.nextExchangeResult = OAuthTokenSet(
            accessToken: "access-2",
            refreshToken: "refresh-2",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 20_000)
        )

        try await provider.signIn()
        let token = try await provider.bearerToken()

        XCTAssertEqual(token, "access-2")
        XCTAssertEqual(try store.load()?.refreshToken, "refresh-2")
    }

    func testForegroundBackgroundRestoreRefreshesExpiredSession() async {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "old-access",
            refreshToken: "refresh-existing",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        ))

        let oauth = StubCognitoOAuthClient()
        oauth.nextRefreshResult = OAuthTokenSet(
            accessToken: "new-access",
            refreshToken: "refresh-existing",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 2_000)
        )

        let provider = CognitoAuthProvider(
            oauthClient: oauth,
            tokenStore: store,
            clock: FixedClock(now: Date(timeIntervalSince1970: 1_000))
        )

        let restored = await provider.restoreSession()
        let token = try? await provider.bearerToken()

        XCTAssertTrue(restored)
        XCTAssertEqual(token, "new-access")
        XCTAssertEqual(oauth.refreshCalls, 1)
    }

    func testRejectedRefreshTokenReportsTheEndedSessionOnce() async {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "expired-access",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        ))
        let oauth = StubCognitoOAuthClient()
        oauth.refreshError = APIClientError.unauthenticated(nil)
        oauth.refreshDelayNanoseconds = 20_000_000
        let provider = CognitoAuthProvider(oauthClient: oauth, tokenStore: store, clock: FixedClock(now: Date(timeIntervalSince1970: 1_000)))
        let ended = CallCounter()
        await provider.setSessionEndedHandler { ended.increment() }

        async let first = try? provider.bearerToken()
        async let second = try? provider.bearerToken()
        let tokens = await [first, second]

        XCTAssertEqual(tokens, [nil, nil])
        XCTAssertEqual(ended.count, 1)
        XCTAssertEqual(oauth.refreshCalls, 1)
        XCTAssertNil(try? store.load())
    }

    func testSignOutCancelsTheRefreshInFlightAndKeepsTheTokensCleared() async {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "expired-access",
            refreshToken: "refresh-token",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        ))
        let oauth = StubCognitoOAuthClient()
        oauth.refreshDelayNanoseconds = 200_000_000
        oauth.ignoresCancellation = true
        let provider = CognitoAuthProvider(oauthClient: oauth, tokenStore: store, clock: FixedClock(now: Date(timeIntervalSince1970: 1_000)))
        let ended = CallCounter()
        await provider.setSessionEndedHandler { ended.increment() }

        let request = Task { try await provider.bearerToken() }
        try? await Task.sleep(nanoseconds: 50_000_000)
        await provider.signOut()

        do {
            _ = try await request.value
            XCTFail("a refresh finishing after sign-out must not hand out its token")
        } catch APIClientError.unauthenticated {
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertNil(try? store.load(), "the late refresh must not write tokens back")
        let restored = await provider.restoreSession()
        XCTAssertFalse(restored)
        XCTAssertEqual(ended.count, 0, "signing out on purpose is not an ended session")
    }

    func testStaleRefreshFailureDoesNotEndTheNewSession() async throws {
        let store = InMemoryTokenStore(seed: OAuthTokenSet(
            accessToken: "expired-access",
            refreshToken: "refresh-old",
            idToken: nil,
            expiresAt: Date(timeIntervalSince1970: 900)
        ))
        let oauth = StubCognitoOAuthClient()
        oauth.refreshError = APIClientError.unauthenticated(nil)
        oauth.refreshDelayNanoseconds = 200_000_000
        oauth.ignoresCancellation = true
        oauth.nextExchangeResult = OAuthTokenSet(accessToken: "access-new", refreshToken: "refresh-new", idToken: nil, expiresAt: Date(timeIntervalSince1970: 10_000))
        let provider = CognitoAuthProvider(oauthClient: oauth, tokenStore: store, clock: FixedClock(now: Date(timeIntervalSince1970: 1_000)))
        let ended = CallCounter()
        await provider.setSessionEndedHandler { ended.increment() }

        let request = Task { try await provider.bearerToken() }
        try? await Task.sleep(nanoseconds: 50_000_000)
        await provider.signOut()
        try await provider.signIn()

        let token = try await request.value
        XCTAssertEqual(token, "access-new", "the request is answered with the new session's token")
        XCTAssertEqual(try store.load()?.refreshToken, "refresh-new")
        XCTAssertEqual(ended.count, 0)
    }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var count: Int { lock.withLock { value } }

    func increment() {
        lock.withLock { value += 1 }
    }
}

private struct FixedClock: Clock {
    let now: Date
}

private final class InMemoryTokenStore: OAuthTokenStore {
    private var value: OAuthTokenSet?

    init(seed: OAuthTokenSet? = nil) {
        value = seed
    }

    var loadError: Error?

    func load() throws -> OAuthTokenSet? {
        if let loadError {
            throw loadError
        }
        return value
    }

    func save(_ tokenSet: OAuthTokenSet) throws {
        value = tokenSet
    }

    func clear() throws {
        value = nil
    }
}

private final class StubCognitoOAuthClient: CognitoOAuthClientProtocol {
    var nextAuthorizationCode = OAuthAuthorizationCode(code: "code", state: "state", codeVerifier: "verifier")
    var nextExchangeResult = OAuthTokenSet(accessToken: "access", refreshToken: "refresh", idToken: nil, expiresAt: Date(timeIntervalSince1970: 10_000))
    var nextRefreshResult = OAuthTokenSet(accessToken: "access-refreshed", refreshToken: "refresh", idToken: nil, expiresAt: Date(timeIntervalSince1970: 10_000))
    var refreshError: Error?
    var refreshDelayNanoseconds: UInt64 = 0
    /// The token request finishes even when its task is cancelled (an answer already on the way).
    var ignoresCancellation = false
    private(set) var refreshCalls = 0

    func startAuthorization() async throws -> OAuthAuthorizationCode {
        nextAuthorizationCode
    }

    func exchangeCode(_ authorization: OAuthAuthorizationCode) async throws -> OAuthTokenSet {
        _ = authorization
        return nextExchangeResult
    }

    func refresh(refreshToken: String) async throws -> OAuthTokenSet {
        _ = refreshToken
        refreshCalls += 1
        if refreshDelayNanoseconds > 0 {
            if ignoresCancellation {
                let deadline = DispatchTime.now().uptimeNanoseconds + refreshDelayNanoseconds
                while DispatchTime.now().uptimeNanoseconds < deadline {
                    await Task.yield()
                }
            } else {
                try await Task.sleep(nanoseconds: refreshDelayNanoseconds)
            }
        }
        if let refreshError {
            throw refreshError
        }

        return nextRefreshResult
    }
}
