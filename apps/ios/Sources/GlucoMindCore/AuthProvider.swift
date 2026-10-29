import Foundation

public protocol AuthProvider {
    func bearerToken() async throws -> String
}

public protocol SessionAuthProvider: AuthProvider {
    func restoreSession() async -> Bool
    func signIn() async throws
    func signOut() async
}

#if DEBUG
public struct DevelopmentTokenAuthProvider: AuthProvider {
    private let token: String

    public init(token: String) {
        self.token = token
    }

    public func bearerToken() async throws -> String {
        if token.isEmpty {
            throw APIClientError.unauthenticated(nil)
        }

        return token
    }
}
#endif
