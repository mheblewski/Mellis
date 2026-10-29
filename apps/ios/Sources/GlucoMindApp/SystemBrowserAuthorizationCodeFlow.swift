import Foundation
import GlucoMindCore

#if canImport(AuthenticationServices) && canImport(UIKit)
import AuthenticationServices
import UIKit

@MainActor
final class SystemBrowserAuthorizationCodeFlow: NSObject, AuthorizationCodeFlow, ASWebAuthenticationPresentationContextProviding {
    private var activeSession: ASWebAuthenticationSession?

    func authorize(requestURL: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: requestURL, callbackURLScheme: callbackScheme) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                    return
                }

                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                continuation.resume(throwing: APIClientError.unauthenticated(nil))
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            activeSession = session

            guard session.start() else {
                activeSession = nil
                continuation.resume(throwing: APIClientError.unauthenticated(nil))
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene,
                  let window = windowScene.windows.first(where: { $0.isKeyWindow }) else {
                continue
            }

            return window
        }

        return ASPresentationAnchor()
    }
}

#else
@MainActor
final class SystemBrowserAuthorizationCodeFlow: AuthorizationCodeFlow {
    func authorize(requestURL: URL, callbackScheme: String) async throws -> URL {
        _ = requestURL
        _ = callbackScheme
        throw APIClientError.unauthenticated(nil)
    }
}
#endif
