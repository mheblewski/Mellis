import Foundation

/// Which build of the app is running: marketing version, build number (commit count of main, stamped by the build
/// script in project.yml) and the commit it was built from ("+" when it had uncommitted changes).
public struct AppBuildInfo: Equatable {
    public let version: String
    /// nil when the app was not built by Xcode with the build script (e.g. `swift build`, tests).
    public let build: Int?
    public let commit: String?

    public init(version: String, build: Int?, commit: String?) {
        self.version = version
        self.build = build
        self.commit = commit
    }

    public init(infoDictionary: [String: Any]) {
        version = (infoDictionary["CFBundleShortVersionString"] as? String) ?? "?"
        // The source Info.plist says build "1" and commit "dev": that is an unstamped build, not build 1.
        let commit = (infoDictionary["GMGitCommit"] as? String).flatMap { $0.isEmpty || $0 == "dev" ? nil : $0 }
        self.commit = commit
        build = commit == nil ? nil : (infoDictionary["CFBundleVersion"] as? String).flatMap(Int.init)
    }

    public static let current = AppBuildInfo(infoDictionary: Bundle.main.infoDictionary ?? [:])

    /// "Mellis 1.0.0 (build 97)" (Ustawienia → O aplikacji): the release number shared with the server and the build.
    public var aboutText: String {
        guard let build else {
            return "Mellis \(version) (dev)"
        }
        return "Mellis \(version) (build \(build))"
    }

    /// "0.1 (97 · d37e1ab)", or "0.1 (dev)" for an unstamped build. Shown in the menu and sent to the server.
    public var displayText: String {
        guard let build else {
            return "\(version) (dev)"
        }
        return commit.map { "\(version) (\(build) · \($0))" } ?? "\(version) (\(build))"
    }
}

/// The server's requirements for the app (GET /v1/app-config).
public struct AppConfigResponse: Codable, Equatable {
    public struct IOS: Codable, Equatable {
        public let min_build: Int
        public let update_message: String

        public init(min_build: Int, update_message: String) {
            self.min_build = min_build
            self.update_message = update_message
        }
    }

    /// The server's own version, when it says (Settings → O aplikacji); absent on today's servers.
    public struct Server: Codable, Equatable {
        public let version: String?

        public init(version: String?) {
            self.version = version
        }
    }

    /// Where voice messages are transcribed; nil from a server older than the field (the server, as before).
    public struct Voice: Codable, Equatable {
        public let server_transcription: Bool

        public init(server_transcription: Bool) {
            self.server_transcription = server_transcription
        }
    }

    public let ios: IOS
    public var server: Server? = nil
    public let voice: Voice?

    public init(ios: IOS, server: Server? = nil, voice: Voice? = nil) {
        self.ios = ios
        self.server = server
        self.voice = voice
    }
}

public enum AppUpdatePolicy {
    /// The update message when this build is older than the server's minimum; nil otherwise. An unstamped build (dev,
    /// tests) is never told to update.
    public static func updateMessage(build: AppBuildInfo, config: AppConfigResponse?) -> String? {
        guard let config, let number = build.build, number < config.ios.min_build else {
            return nil
        }
        return config.ios.update_message
    }
}
