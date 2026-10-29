import Foundation

public enum RuntimeAuthMode: Equatable {
    case cognito
    /// Self-hosted Mellis (backend AUTH_MODE=device): no accounts; the phone pairs with a server from a QR code and
    /// signs in with its own Secure Enclave keys. The server address comes from the pairing, never from the build.
    case device
    case disabledLocal
    /// Debug-only shared development bearer token (backend AUTH_MODE=local_token).
    case localToken
}

public enum RuntimeAuthModeResolutionError: Error, Equatable {
    case invalidAuthMode
    case disabledModeNotAllowed
    case invalidAllowDisabledFlag
    case localTokenNotAllowed
    case missingLocalToken
}

public struct RuntimeAuthModeResolver {
    /// `cognitoConfigured`: COGNITO_DOMAIN_URL and COGNITO_CLIENT_ID are set. A community build leaves them empty (the
    /// default Config.xcconfig) and gets device mode without any setting; AUTH_MODE = device chooses it explicitly.
    public static func resolve(authModeValue: String?, allowDisabledValue: String?, isDebugBuild: Bool, cognitoConfigured: Bool = true) throws -> RuntimeAuthMode {
        let mode = (authModeValue ?? "cognito").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        guard mode == "cognito" || mode == "device" || mode == "disabled" || mode == "local_token" else {
            throw RuntimeAuthModeResolutionError.invalidAuthMode
        }

        if mode == "device" {
            return .device
        }

        if mode == "cognito" {
            return cognitoConfigured ? .cognito : .device
        }

        if mode == "local_token" {
            // A development secret: never accepted outside Debug builds.
            guard isDebugBuild else {
                throw RuntimeAuthModeResolutionError.localTokenNotAllowed
            }
            return .localToken
        }

        guard isDebugBuild else {
            throw RuntimeAuthModeResolutionError.disabledModeNotAllowed
        }

        guard let allowDisabled = parseBoolean(allowDisabledValue) else {
            throw RuntimeAuthModeResolutionError.invalidAllowDisabledFlag
        }

        guard allowDisabled else {
            throw RuntimeAuthModeResolutionError.disabledModeNotAllowed
        }

        return .disabledLocal
    }

    /// The configured development token; empty, unexpanded `$(...)` or `<placeholder>` values are refused.
    public static func resolveLocalToken(_ value: String?) throws -> String {
        let token = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !token.isEmpty, !token.hasPrefix("$("), !(token.hasPrefix("<") && token.hasSuffix(">")) else {
            throw RuntimeAuthModeResolutionError.missingLocalToken
        }
        return token
    }

    private static func parseBoolean(_ value: String?) -> Bool? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !raw.isEmpty else {
            return false
        }

        if raw == "true" || raw == "1" {
            return true
        }

        if raw == "false" || raw == "0" {
            return false
        }

        return nil
    }
}
