import XCTest
@testable import GlucoMindCore

final class DeviceReleaseTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let name = "device-release-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testTheSecretIsMadeOnceAndIsLongEnough() {
        let defaults = freshDefaults()
        let first = DeviceReleaseSecret.current(defaults: defaults)
        XCTAssertGreaterThanOrEqual(first.count, 32)
        XCTAssertEqual(DeviceReleaseSecret.current(defaults: defaults), first)
        XCTAssertNotEqual(DeviceReleaseSecret.current(defaults: freshDefaults()), first)
    }

    func testAPendingReleaseIsKeptUntilCleared() {
        let defaults = freshDefaults()
        XCTAssertNil(PendingDeviceRelease.pushToken(defaults: defaults))
        PendingDeviceRelease.save(pushToken: "token-a", defaults: defaults)
        XCTAssertEqual(PendingDeviceRelease.pushToken(defaults: defaults), "token-a")
        PendingDeviceRelease.clear(defaults: defaults)
        XCTAssertNil(PendingDeviceRelease.pushToken(defaults: defaults))
    }

    func testTheRegistrationSendsTheSecretOnlyWhenThereIsOne() throws {
        let encoder = JSONEncoder()
        let without = try JSONSerialization.jsonObject(with: encoder.encode(DeviceRegistrationRequest(platform: "ios", device_id: "d", push_token: "t", app_version: nil))) as! [String: Any]
        XCTAssertNil(without["release_secret"])
        let with = try JSONSerialization.jsonObject(with: encoder.encode(DeviceRegistrationRequest(platform: "ios", device_id: "d", push_token: "t", app_version: nil, release_secret: "s"))) as! [String: Any]
        XCTAssertEqual(with["release_secret"] as? String, "s")
    }
}
