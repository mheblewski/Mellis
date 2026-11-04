import Foundation
import WidgetKit

/// The complications' WidgetKit push token (watchOS 26): sent to the server, which pushes "content-changed" when a
/// patient's reading changes enough (widget-push worker), so watchOS reloads the timelines sooner than its own schedule.
/// Apple budgets these pushes; the complication's own timeline stays the fallback.
@available(watchOS 26.0, *)
struct WatchWidgetPushHandler: WidgetPushHandler {
    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        let token = pushInfo.token.map { String(format: "%02x", $0) }.joined()
        WatchWidgetPush.tokenChanged(token, hasWidgets: !widgets.isEmpty)
    }
}

enum WatchWidgetPush {
    private static let defaults = UserDefaults.standard
    private static let tokenKey = "watch.widget-push.token"
    private static let registeredKey = "watch.widget-push.registered"

    static func tokenChanged(_ token: String, hasWidgets: Bool) {
        defaults.set(token, forKey: tokenKey)
        guard hasWidgets else { return }
        Task {
            guard let client = try? WatchSession.client() else { return }
            await registerIfNeeded(client: client)
        }
    }

    /// Sends the token once per push token and watch token (again after the phone made a new watch token). The server
    /// takes the watch token's patients. A failure is retried on the next timeline read.
    static func registerIfNeeded(client: WatchAPIClient) async {
        guard !WatchSession.usesFixtures, let token = defaults.string(forKey: tokenKey) else { return }
        let signature = [token, WatchSession.apnsEnvironment, client.tokenFingerprint].joined(separator: ",")
        guard defaults.string(forKey: registeredKey) != signature else { return }
        do {
            try await client.registerWidgetPushToken(token)
            defaults.set(signature, forKey: registeredKey)
            NSLog("[WATCH] widget push token registered")
        } catch {
            NSLog("[WATCH] widget push token registration failed: %@", String(describing: error))
        }
    }
}
