import Foundation

/// The watch's server and token: the read-only watch token the phone made for this watch (WatchSessionBridge,
/// WatchLink), with the server's address and the token's patients, in the watch's own Keychain group shared by the
/// watch app and its complications. The watch never signs in itself: with no token it asks the caregiver to open the
/// phone app.
public enum WatchSession {
    public enum Failure: Error {
        case signedOut
    }

    /// The phone's hand-over on this watch.
    public static var credentialStore: KeychainCodableItem<WatchLink.Credentials> {
        KeychainCodableItem(service: "pl.mellis.watch", account: "watch.credentials", accessGroup: value("GMKeychainAccessGroup"))
    }

    public static func client() throws -> WatchAPIClient {
        guard let credentials = credentialStore.load() else { throw Failure.signedOut }
        return WatchAPIClient(credentials: credentials)
    }

    /// Debug builds made for the simulator (GM_WIDGET_FIXTURES = YES): sample data, no network.
    public static var usesFixtures: Bool {
        #if DEBUG
        return value("GM_WIDGET_FIXTURES") == "YES"
        #else
        return false
        #endif
    }

    /// The APNs host this build's push token belongs to. The token follows the signature, not a build setting (a
    /// Mac-installed Release build said "production", its token was a sandbox one, and every push failed): the embedded
    /// profile's aps-environment; no profile on a device means App Store or TestFlight; the simulator and an unreadable
    /// profile fall back to GM_APNS_PRODUCTION. As GlucoMindPushIdentity on the phone.
    public static var apnsEnvironment: String {
        let fallback = value("GMAPNSProduction") == "YES"
        #if targetEnvironment(simulator)
        let production = fallback
        #else
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        let production = profile == nil ? true : (productionFromProfile(profile) ?? fallback)
        #endif
        return production ? "production" : "sandbox"
    }

    /// A provisioning profile's aps-environment (a signed envelope around a plain XML plist).
    static func productionFromProfile(_ data: Data?) -> Bool? {
        guard let data,
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else { return nil }
        let plist = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let root = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              let entitlements = root["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String else { return nil }
        return environment == "production"
    }

    public static func value(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
    }
}

/// The two requests the watch makes with its watch token: the glance of all its patients (GET /v1/watch/glance)
/// and the complications' WidgetKit push token.
public struct WatchAPIClient {
    let credentials: WatchLink.Credentials
    let http: HTTPClient = URLSessionHTTPClient()

    /// Which token this is, without revealing it (sent to the phone when the server refuses it).
    public var tokenFingerprint: String { WatchLink.fingerprint(credentials.token) }

    /// Every patient of the token in its order, with the latest reading (one request).
    public func glances() async throws -> [WatchGlance] {
        let (data, response) = try await http.perform(request("/v1/watch/glance", method: "GET",
                                                              query: [URLQueryItem(name: "hours", value: String(WatchChart.hours))]))
        try check(response.statusCode, data)
        let glance = try JSONDecoder().decode(Glance.self, from: data)
        return glance.p.map { entry in
            WatchGlance(
                patient: WatchPatient(id: entry.id, name: entry.n),
                value: entry.v,
                direction: GlucoseTrend.direction(nightscout: entry.dir, delta: entry.dl.map(Double.init)),
                delta: entry.dl,
                observedAt: entry.at.map { Date(timeIntervalSince1970: TimeInterval($0)) },
                iob: entry.iob,
                cob: entry.cob,
                history: entry.r?.compactMap { pair in
                    pair.count == 2 ? WatchPoint(at: Date(timeIntervalSince1970: pair[0]), value: Int(pair[1])) : nil
                }
            )
        }
    }

    /// Where the server sends the complications' WidgetKit pushes (for the token's patients).
    public func registerWidgetPushToken(_ token: String) async throws {
        guard let topic = WatchSession.value("GMWidgetPushTopic") else { return }
        let body = WidgetPushTokenBody(token: token, topic: topic, environment: WatchSession.apnsEnvironment, platform: "watchos")
        var request = request("/v1/watch/widget-push-token", method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await http.perform(request)
        try check(response.statusCode, data)
    }

    private func request(_ path: String, method: String, query: [URLQueryItem] = []) -> URLRequest {
        var url = credentials.baseURL.appendingPathComponent(path)
        if !query.isEmpty, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = query
            url = components.url ?? url
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func check(_ status: Int, _ data: Data) throws {
        guard !(200..<300).contains(status) else { return }
        let problem = try? JSONDecoder().decode(ProblemDetails.self, from: data)
        throw status == 401 ? APIClientError.unauthenticated(problem) : APIClientError.unexpectedStatus(status, problem)
    }

    /// GET /v1/watch/glance (watch-glance.v1).
    private struct Glance: Decodable {
        struct Entry: Decodable {
            let id: String
            let n: String
            let v: Int?
            let dir: String?
            let dl: Int?
            let at: Int?
            let iob: Double?
            let cob: Double?
            /// [epoch seconds, mg/dL] of the last hours (asked with ?hours=).
            let r: [[Double]]?
        }
        let p: [Entry]
    }

    private struct WidgetPushTokenBody: Encodable {
        let token: String
        let topic: String
        let environment: String
        let platform: String
    }
}
