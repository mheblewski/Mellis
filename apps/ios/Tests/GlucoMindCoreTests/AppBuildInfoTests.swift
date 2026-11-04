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

    // MARK: "Jest nowa wersja"

    private func config(latest: String?, server: String? = "1.0.30", safety: Bool = false, notes: String? = "https://github.com/x/y/releases/tag/v1") -> AppConfigResponse {
        AppConfigResponse(
            ios: .init(min_build: 1, update_message: "x"),
            server: .init(version: server),
            latest_release: latest.map { .init(version: $0, notes_url: notes, safety: safety) }
        )
    }

    private let app = AppBuildInfo(version: "1.0.30", build: 1200, commit: "abc1234")

    func testNoNoticeWhenEverythingIsCurrentOrUnchecked() {
        XCTAssertNil(AppUpdateNotice(build: app, config: config(latest: "1.0.30")))
        XCTAssertNil(AppUpdateNotice(build: app, config: config(latest: "1.0.29")))
        XCTAssertNil(AppUpdateNotice(build: app, config: config(latest: nil)))
        XCTAssertNil(AppUpdateNotice(build: app, config: nil))
    }

    func testBothBehindListsTheServerFirst() throws {
        let notice = try XCTUnwrap(AppUpdateNotice(build: app, config: config(latest: "1.0.31")))
        XCTAssertEqual(notice.title, "Jest nowa wersja 1.0.31")
        XCTAssertEqual(notice.steps.count, 2)
        XCTAssertTrue(notice.steps[0].hasPrefix("Serwer:"))
        XCTAssertTrue(notice.steps[1].hasPrefix("Aplikacja:"))
    }

    func testOnlyTheOneBehindGetsAStep() throws {
        let appOnly = try XCTUnwrap(AppUpdateNotice(build: app, config: config(latest: "1.0.31", server: "1.0.31")))
        XCTAssertFalse(appOnly.serverBehind)
        XCTAssertEqual(appOnly.steps.count, 1)
        XCTAssertTrue(appOnly.steps[0].hasPrefix("Aplikacja:"))
        let newerApp = AppBuildInfo(version: "1.0.31", build: 1300, commit: nil)
        let serverOnly = try XCTUnwrap(AppUpdateNotice(build: newerApp, config: config(latest: "1.0.31")))
        XCTAssertFalse(serverOnly.appBehind)
        XCTAssertTrue(serverOnly.steps[0].hasPrefix("Serwer:"))
    }

    func testComparesNumbersNotText() {
        XCTAssertTrue(AppUpdateNotice.isNewer("1.0.100", than: "1.0.99"))
        XCTAssertTrue(AppUpdateNotice.isNewer("1.1.0", than: "1.0.99"))
        XCTAssertFalse(AppUpdateNotice.isNewer("1.0.99", than: "1.0.100"))
        XCTAssertFalse(AppUpdateNotice.isNewer("1.0.30", than: "1.0.30"))
        XCTAssertFalse(AppUpdateNotice.isNewer("1.0.31", than: nil))
        XCTAssertFalse(AppUpdateNotice.isNewer("1.0.31", than: "?"))
    }

    func testAnUnstampedBuildIsNeverTold() {
        XCTAssertNil(AppUpdateNotice(build: AppBuildInfo(version: "1.0.30", build: nil, commit: nil), config: config(latest: "1.0.31")))
    }

    func testOnlyAnHttpsNotesLinkIsKept() throws {
        XCTAssertNotNil(try XCTUnwrap(AppUpdateNotice(build: app, config: config(latest: "1.0.31"))).notesURL)
        XCTAssertNil(try XCTUnwrap(AppUpdateNotice(build: app, config: config(latest: "1.0.31", notes: "http://example.com"))).notesURL)
    }

    func testDecodesTheServerAnswerAndAnOlderOne() throws {
        let body = #"{"ios":{"min_build":1,"update_message":"x"},"server":{"version":"1.0.30"},"latest_release":{"version":"1.0.31","notes_url":null,"safety":true}}"#
        let decoded = try JSONDecoder().decode(AppConfigResponse.self, from: Data(body.utf8))
        XCTAssertEqual(decoded.latest_release?.safety, true)
        let older = try JSONDecoder().decode(AppConfigResponse.self, from: Data(#"{"ios":{"min_build":1,"update_message":"x"}}"#.utf8))
        XCTAssertNil(older.latest_release)
    }

    func testTheSafetyPushOpensAboutForItsPatient() {
        let id = "11111111-1111-1111-1111-111111111111"
        let payload: [AnyHashable: Any] = ["gluco": ["type": "app_update", "patientId": id, "routePath": "/patients/\(id)"]]
        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .about(patientID: id))
    }
}
