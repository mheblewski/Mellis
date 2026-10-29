import Foundation
import Security

/// This phone's release secret (audit 2026-10-26): random, made once per install and sent with every device
/// registration (the server keeps only its hash). With it the phone releases its rows without a session, when its
/// sign-out could not reach the server (POST /v1/devices/release).
public enum DeviceReleaseSecret {
    private static let key = "gluco.device.release-secret"

    public static func current(defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: key), existing.count >= 32 {
            return existing
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let created = status == errSecSuccess
            ? Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            : (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        defaults.set(created, forKey: key)
        return created
    }
}

/// A sign-out that could not reach the server (offline): the push token still to release. Cleared once released, or
/// when the phone registers again (a new sign-in takes the phone over on the server).
public enum PendingDeviceRelease {
    private static let key = "gluco.device.pending-release-token"

    public static func pushToken(defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: key).flatMap { $0.isEmpty ? nil : $0 }
    }

    public static func save(pushToken: String, defaults: UserDefaults = .standard) {
        defaults.set(pushToken, forKey: key)
    }

    public static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}
