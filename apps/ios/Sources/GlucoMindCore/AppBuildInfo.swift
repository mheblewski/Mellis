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

    /// The newest release the server knows of (release-check.v1); nil when it does not check.
    public struct LatestRelease: Codable, Equatable {
        public let version: String
        public let notes_url: String?
        /// The server is behind a safety fix.
        public let safety: Bool

        public init(version: String, notes_url: String?, safety: Bool) {
            self.version = version
            self.notes_url = notes_url
            self.safety = safety
        }
    }

    public let ios: IOS
    public var server: Server? = nil
    public var latest_release: LatestRelease? = nil
    public let voice: Voice?

    public init(ios: IOS, server: Server? = nil, latest_release: LatestRelease? = nil, voice: Voice? = nil) {
        self.ios = ios
        self.server = server
        self.latest_release = latest_release
        self.voice = voice
    }
}

/// "Jest nowa wersja" (Ustawienia → O aplikacji): what is behind the newest release and what to do about it. Neither the
/// server nor the app can update itself, so it only says what to run and where, server first.
public struct AppUpdateNotice: Equatable {
    public let version: String
    public let notesURL: URL?
    public let safety: Bool
    public let serverBehind: Bool
    public let appBehind: Bool

    /// Nil when both are up to date, the server does not check, or the app is an unstamped build (dev, tests).
    public init?(build: AppBuildInfo, config: AppConfigResponse?) {
        guard build.build != nil, let latest = config?.latest_release else { return nil }
        let serverBehind = Self.isNewer(latest.version, than: config?.server?.version)
        let appBehind = Self.isNewer(latest.version, than: build.version)
        guard serverBehind || appBehind else { return nil }
        version = latest.version
        notesURL = latest.notes_url.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
        safety = latest.safety
        self.serverBehind = serverBehind
        self.appBehind = appBehind
    }

    public var title: String { "Jest nowa wersja \(version)" }

    public var steps: [String] {
        var result: [String] = []
        if serverBehind {
            result.append("Serwer: połącz się z serwerem i wpisz polecenie mellis update.")
        }
        if appBehind {
            result.append("Aplikacja: na Macu uruchom tę samą komendę co przy instalacji aplikacji.")
        }
        return result
    }

    /// Compares release numbers (X.Y.Z) part by part; false when either side is not one.
    static func isNewer(_ candidate: String, than current: String?) -> Bool {
        func parts(_ text: String?) -> [Int]? {
            let numbers = (text ?? "").split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
            guard numbers.count == 3, numbers.allSatisfy({ $0 != nil }) else { return nil }
            return numbers.compactMap { $0 }
        }
        guard let a = parts(candidate), let b = parts(current) else { return false }
        return a.lexicographicallyPrecedes(b) == false && a != b
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
