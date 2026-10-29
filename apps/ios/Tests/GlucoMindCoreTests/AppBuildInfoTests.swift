import XCTest
@testable import GlucoMindCore

final class AppBuildInfoTests: XCTestCase {
    func testReadsAStampedBuild() {
        let info = AppBuildInfo(infoDictionary: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "94", "GMGitCommit": "445deba"])
        XCTAssertEqual(info, AppBuildInfo(version: "1.0", build: 94, commit: "445deba"))
        XCTAssertEqual(info.displayText, "1.0 (94 · 445deba)")
        XCTAssertEqual(info.aboutText, "Mellis 1.0 (build 94)")
    }

    func testAnUnstampedBuildHasNoNumber() {
        // The source Info.plist values: build "1", commit "dev".
        let info = AppBuildInfo(infoDictionary: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "1", "GMGitCommit": "dev"])
        XCTAssertNil(info.build)
        XCTAssertEqual(info.displayText, "1.0 (dev)")
        XCTAssertEqual(AppBuildInfo(infoDictionary: [:]).displayText, "? (dev)")
        XCTAssertEqual(info.aboutText, "Mellis 1.0 (dev)")
    }

    func testKeepsTheDirtyMarker() {
        let info = AppBuildInfo(infoDictionary: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "95", "GMGitCommit": "abc1234+"])
        XCTAssertEqual(info.displayText, "1.0 (95 · abc1234+)")
    }

    func testAsksForAnUpdateOnlyBelowTheServersMinimum() {
        let config = AppConfigResponse(ios: .init(min_build: 94, update_message: "Zainstaluj nową wersję."))
        XCTAssertEqual(AppUpdatePolicy.updateMessage(build: AppBuildInfo(version: "1.0", build: 93, commit: "a"), config: config), "Zainstaluj nową wersję.")
        XCTAssertNil(AppUpdatePolicy.updateMessage(build: AppBuildInfo(version: "1.0", build: 94, commit: "a"), config: config))
        XCTAssertNil(AppUpdatePolicy.updateMessage(build: AppBuildInfo(version: "1.0", build: nil, commit: nil), config: config))
        XCTAssertNil(AppUpdatePolicy.updateMessage(build: AppBuildInfo(version: "1.0", build: 10, commit: "a"), config: nil))
    }

    func testReadsTheAppConfigWithoutSigningIn() async throws {
        var seen: URLRequest?
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: FailingAuthProvider(),
            httpClient: RecordingHTTPClient { request in
                seen = request
                return (Data(#"{"ios":{"min_build":94,"update_message":"x"}}"#.utf8), 200)
            }
        )

        let config = try await client.getAppConfig()

        XCTAssertEqual(config.ios.min_build, 94)
        XCTAssertEqual(seen?.url?.path, "/v1/app-config")
        XCTAssertNil(seen?.value(forHTTPHeaderField: "Authorization"))
    }
}

private struct FailingAuthProvider: AuthProvider {
    struct SignedOut: Error {}
    func bearerToken() async throws -> String { throw SignedOut() }
}

private final class RecordingHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
