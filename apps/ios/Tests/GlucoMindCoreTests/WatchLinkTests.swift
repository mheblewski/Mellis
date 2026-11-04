import XCTest
@testable import GlucoMindCore

final class WatchLinkTests: XCTestCase {
    private let token = "gmw_" + String(repeating: "a", count: 43)
    private let server = URL(string: "https://mellis.example")!

    func testContextRoundTripsTheCredentials() {
        let credentials = WatchLink.Credentials(token: token, baseURL: server, patients: [
            WatchLink.Patient(id: "p-1", name: "Ania"),
            WatchLink.Patient(id: "p-2", name: "Zosia"),
        ])
        let context = WatchLink.context(credentials)
        XCTAssertEqual(context[WatchLink.watchTokenKey] as? String, token)
        XCTAssertEqual(context[WatchLink.baseURLKey] as? String, "https://mellis.example")
        XCTAssertEqual(WatchLink.parse(context), .credentials(credentials))
    }

    func testSignedOutAndUnknownContexts() {
        XCTAssertEqual(WatchLink.parse(WatchLink.signedOutContext), .signedOut)
        XCTAssertNil(WatchLink.parse([:]))
        // An older build's Cognito hand-over is not a watch token.
        XCTAssertNil(WatchLink.parse(["tokens": Data()]))
        XCTAssertNil(WatchLink.parse([WatchLink.watchTokenKey: "eyJhbGciOi.jwt", WatchLink.baseURLKey: "https://mellis.example"]))
        XCTAssertNil(WatchLink.parse([WatchLink.watchTokenKey: token, WatchLink.baseURLKey: "no scheme"]))
    }

    func testResentContextIsTheSameCredentialsButNotAnIdenticalDictionary() {
        let context = WatchLink.context(WatchLink.Credentials(token: token, baseURL: server, patients: []))
        let resent = WatchLink.resent(context, at: Date(timeIntervalSince1970: 100))
        XCTAssertFalse(NSDictionary(dictionary: context).isEqual(to: resent))
        XCTAssertTrue(WatchLink.sameContext(context, resent))
        XCTAssertTrue(WatchLink.sameContext(resent, WatchLink.resent(context, at: Date(timeIntervalSince1970: 200))))
        XCTAssertFalse(WatchLink.sameContext(context, WatchLink.signedOutContext))
        XCTAssertEqual(WatchLink.parse(resent), WatchLink.parse(context))
    }

    func testMissingPatientsAreAnEmptyList() {
        let parsed = WatchLink.parse([WatchLink.watchTokenKey: token, WatchLink.baseURLKey: "https://mellis.example"])
        XCTAssertEqual(parsed, .credentials(WatchLink.Credentials(token: token, baseURL: server, patients: [])))
    }

    func testTokenShapeAndFingerprint() {
        XCTAssertTrue(WatchLink.isWatchTokenShape(token))
        XCTAssertFalse(WatchLink.isWatchTokenShape("gmw_short"))
        XCTAssertFalse(WatchLink.isWatchTokenShape("xyz_" + String(repeating: "a", count: 43)))
        let fingerprint = WatchLink.fingerprint(token)
        XCTAssertEqual(fingerprint.count, 16)
        XCTAssertEqual(fingerprint, WatchLink.fingerprint(token))
        XCTAssertNotEqual(fingerprint, WatchLink.fingerprint("gmw_" + String(repeating: "b", count: 43)))
        XCTAssertFalse(fingerprint.contains("aaaa"))
    }
}
