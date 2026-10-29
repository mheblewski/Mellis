import Foundation
import GlucoMindCore

/// The widget's server: the same API, sign-in and Keychain session as the app (Info.plist carries the same keys). The
/// widget never signs in: with no session it asks the caregiver to open the app. In device mode the server and the
/// device come from the app's pairing (shared Keychain group), never from the build.
enum HomeWidgetAPI {
    enum Failure: Error {
        case signedOut
        case notConfigured
    }

    static func client() throws -> APIClient {
        if usesDeviceAuth {
            return try deviceClient()
        }
        guard let base = value("GLUCOMIND_API_BASE_URL") ?? value("API_BASE_URL"), let baseURL = URL(string: base) else {
            throw Failure.notConfigured
        }
        switch value("AUTH_MODE") ?? "cognito" {
        #if DEBUG
        case "local_token":
            guard let token = value("LOCAL_AUTH_TOKEN") else { throw Failure.notConfigured }
            return APIClient(baseURL: baseURL, authProvider: DevelopmentTokenAuthProvider(token: token), httpClient: URLSessionHTTPClient())
        case "disabled":
            return APIClient(baseURL: baseURL, authorizationMode: .none, httpClient: URLSessionHTTPClient())
        #endif
        default:
            guard let domain = value("COGNITO_DOMAIN_URL").flatMap(URL.init(string:)),
                  let clientID = value("COGNITO_CLIENT_ID"),
                  let redirect = value("COGNITO_REDIRECT_URI").flatMap(URL.init(string:)) else {
                throw Failure.notConfigured
            }
            let config = CognitoOAuthConfiguration(domainURL: domain, clientID: clientID, redirectURI: redirect, scopes: [])
            let oauth = CognitoOAuthClient(config: config, authorizationFlow: NoSignInFlow(), httpClient: URLSessionHTTPClient())
            let store = NonClearingTokenStore(KeychainOAuthTokenStore.session(accessGroup: value("GMKeychainAccessGroup")))
            return APIClient(baseURL: baseURL, authProvider: CognitoAuthProvider(oauthClient: oauth, tokenStore: store), httpClient: URLSessionHTTPClient())
        }
    }

    /// AUTH_MODE = device, or a build without Cognito settings (the app's own rule, RuntimeAuthModeResolver).
    private static var usesDeviceAuth: Bool {
        let mode = (value("AUTH_MODE") ?? "cognito").lowercased()
        if mode == "device" { return true }
        return mode == "cognito" && (value("COGNITO_DOMAIN_URL") == nil || value("COGNITO_CLIENT_ID") == nil)
    }

    /// The paired server with the app's device key: the widget renews the shared session, but a revoked device only
    /// makes it ask to open the app (the app shows the pairing screen).
    private static func deviceClient() throws -> APIClient {
        let accessGroup = value("GMKeychainAccessGroup")
        let store = KeychainDevicePairingStore(accessGroup: accessGroup)
        guard let pairing = try store.loadPairing() else { throw Failure.signedOut }
        let auth = DeviceAuthProvider(
            store: NonClearingDevicePairingStore(store),
            keys: DeviceKeyStores.standard(accessGroup: accessGroup),
            transport: HTTPDeviceAuthTransport(),
            forgetsUnpairedDevice: false
        )
        return APIClient(baseURL: pairing.serverURL, authProvider: auth, httpClient: DeviceSessionHTTPClient(base: URLSessionHTTPClient(), provider: auth))
    }

    /// Debug builds made for the simulator (GM_WIDGET_FIXTURES = YES): sample data, no network.
    static var usesFixtures: Bool {
        #if DEBUG
        return value("GM_WIDGET_FIXTURES") == "YES"
        #else
        return false
        #endif
    }

    private static func value(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
    }
}

private struct NoSignInFlow: AuthorizationCodeFlow {
    func authorize(requestURL: URL, callbackScheme: String) async throws -> URL {
        throw HomeWidgetAPI.Failure.signedOut
    }
}

/// The last dashboard the widget read per patient: shown (greyed by its age) when the next read fails.
enum HomeWidgetCache {
    private static let defaults = UserDefaults.standard

    static func save(_ dashboard: DashboardResponse, patient: AccessiblePatient) {
        guard let data = try? JSONEncoder().encode(Cached(patient_id: patient.patient_id, display_name: patient.display_name, dashboard: dashboard)) else { return }
        defaults.set(data, forKey: key(patient.patient_id))
        defaults.set(patient.patient_id, forKey: "home-widget.last-patient")
    }

    static func load(patientID: String?) -> (patient: AccessiblePatient, dashboard: DashboardResponse)? {
        guard let id = patientID ?? defaults.string(forKey: "home-widget.last-patient"),
              let data = defaults.data(forKey: key(id)),
              let cached = try? JSONDecoder().decode(Cached.self, from: data) else { return nil }
        return (AccessiblePatient(patient_id: cached.patient_id, display_name: cached.display_name), cached.dashboard)
    }

    private static func key(_ patientID: String) -> String { "home-widget.dashboard.\(patientID.lowercased())" }

    private struct Cached: Codable {
        let patient_id: String
        let display_name: String
        let dashboard: DashboardResponse
    }
}
