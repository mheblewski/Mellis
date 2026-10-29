import XCTest
@testable import GlucoMindCore

final class RuntimeAuthModeResolverTests: XCTestCase {
    func testDefaultsToCognitoMode() throws {
        let mode = try RuntimeAuthModeResolver.resolve(
            authModeValue: nil,
            allowDisabledValue: nil,
            isDebugBuild: true
        )

        XCTAssertEqual(mode, .cognito)
    }

    func testAllowsDisabledModeOnlyInDebugWithExplicitFlag() throws {
        let mode = try RuntimeAuthModeResolver.resolve(
            authModeValue: "disabled",
            allowDisabledValue: "true",
            isDebugBuild: true
        )

        XCTAssertEqual(mode, .disabledLocal)
    }

    func testRejectsDisabledModeInNonDebugBuilds() {
        XCTAssertThrowsError(
            try RuntimeAuthModeResolver.resolve(
                authModeValue: "disabled",
                allowDisabledValue: "true",
                isDebugBuild: false
            )
        ) { error in
            XCTAssertEqual(error as? RuntimeAuthModeResolutionError, .disabledModeNotAllowed)
        }
    }

    func testRejectsDisabledModeWithoutExplicitAllowFlag() {
        XCTAssertThrowsError(
            try RuntimeAuthModeResolver.resolve(
                authModeValue: "disabled",
                allowDisabledValue: "false",
                isDebugBuild: true
            )
        ) { error in
            XCTAssertEqual(error as? RuntimeAuthModeResolutionError, .disabledModeNotAllowed)
        }
    }

    /// A community build leaves the Cognito settings empty and gets device auth; AUTH_MODE = device says it outright,
    /// in Release builds too (pairing is the only sign-in there is).
    func testDeviceModeWithoutCognitoSettingsOrWhenAsked() throws {
        XCTAssertEqual(try RuntimeAuthModeResolver.resolve(authModeValue: "cognito", allowDisabledValue: nil, isDebugBuild: false, cognitoConfigured: false), .device)
        XCTAssertEqual(try RuntimeAuthModeResolver.resolve(authModeValue: nil, allowDisabledValue: nil, isDebugBuild: false, cognitoConfigured: false), .device)
        XCTAssertEqual(try RuntimeAuthModeResolver.resolve(authModeValue: " Device ", allowDisabledValue: nil, isDebugBuild: false, cognitoConfigured: true), .device)
        XCTAssertEqual(try RuntimeAuthModeResolver.resolve(authModeValue: "cognito", allowDisabledValue: nil, isDebugBuild: false, cognitoConfigured: true), .cognito)
        // The local development modes keep their own rules.
        XCTAssertEqual(try RuntimeAuthModeResolver.resolve(authModeValue: "disabled", allowDisabledValue: "1", isDebugBuild: true, cognitoConfigured: false), .disabledLocal)
    }

    func testRejectsInvalidMode() {
        XCTAssertThrowsError(
            try RuntimeAuthModeResolver.resolve(
                authModeValue: "invalid",
                allowDisabledValue: "true",
                isDebugBuild: true
            )
        ) { error in
            XCTAssertEqual(error as? RuntimeAuthModeResolutionError, .invalidAuthMode)
        }
    }

    func testAllowsLocalTokenModeInDebugBuilds() throws {
        let mode = try RuntimeAuthModeResolver.resolve(authModeValue: "local_token", allowDisabledValue: "0", isDebugBuild: true)
        XCTAssertEqual(mode, .localToken)
    }

    func testRejectsLocalTokenModeInReleaseBuilds() {
        XCTAssertThrowsError(
            try RuntimeAuthModeResolver.resolve(authModeValue: "local_token", allowDisabledValue: "0", isDebugBuild: false)
        ) { error in
            XCTAssertEqual(error as? RuntimeAuthModeResolutionError, .localTokenNotAllowed)
        }
    }

    func testLocalTokenModeIsNotDisabledMode() throws {
        let mode = try RuntimeAuthModeResolver.resolve(authModeValue: "local_token", allowDisabledValue: "true", isDebugBuild: true)
        XCTAssertNotEqual(mode, .disabledLocal)
    }

    func testResolveLocalTokenRefusesMissingOrUnexpandedValues() {
        for value in [nil, "", "   ", "$(LOCAL_AUTH_TOKEN_EMBEDDED)", "<LOCAL_DEV_TOKEN>"] as [String?] {
            XCTAssertThrowsError(try RuntimeAuthModeResolver.resolveLocalToken(value)) { error in
                XCTAssertEqual(error as? RuntimeAuthModeResolutionError, .missingLocalToken)
            }
        }
        XCTAssertEqual(try RuntimeAuthModeResolver.resolveLocalToken("  synthetic-dev-token "), "synthetic-dev-token")
    }

    /// The tracked xcconfig embeds the development token into Info.plist for Debug only; Release stays empty.
    func testConfigEmbedsLocalTokenOnlyInDebug() throws {
        let configURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Config.xcconfig")
        let lines = try String(contentsOf: configURL, encoding: .utf8)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("LOCAL_AUTH_TOKEN") }
        XCTAssertEqual(lines, [
            "LOCAL_AUTH_TOKEN =",
            "LOCAL_AUTH_TOKEN_EMBEDDED =",
            "LOCAL_AUTH_TOKEN_EMBEDDED[config=Debug] = $(LOCAL_AUTH_TOKEN)",
        ])

        let plistURL = configURL.deletingLastPathComponent().appendingPathComponent("Sources/GlucoMindApp/Info.plist")
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: plistURL), format: nil) as? [String: Any]
        XCTAssertEqual(plist?["LOCAL_AUTH_TOKEN"] as? String, "$(LOCAL_AUTH_TOKEN_EMBEDDED)")
    }
}
