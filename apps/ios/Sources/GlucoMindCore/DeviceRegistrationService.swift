import Foundation

public protocol DeviceRegistrationService {
    func registerDeviceToken(patientID: String, deviceID: String, pushToken: String, appVersion: String?) async throws
}

public struct APIBasedDeviceRegistrationService: DeviceRegistrationService {
    private let apiClient: APIClient

    public init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    public func registerDeviceToken(patientID: String, deviceID: String, pushToken: String, appVersion: String?) async throws {
        _ = try await apiClient.registerDevice(
            patientID: patientID,
            deviceID: deviceID,
            pushToken: pushToken,
            appVersion: appVersion,
            releaseSecret: DeviceReleaseSecret.current()
        )
        // Signed in again: the server gave this phone to the new caregiver, nothing is left to release.
        PendingDeviceRelease.clear()
    }
}

public extension DeviceRegistrationService {
    /// Registers the token for every patient on its own: one refusal (403 after the access was taken away, 404) does
    /// not leave the next patients without notifications. Returns the failures, in the order of `patientIDs`.
    @discardableResult
    func registerDeviceToken(
        patientIDs: [String],
        deviceID: String,
        pushToken: String,
        appVersion: String?
    ) async -> [(patientID: String, error: Error)] {
        var failures: [(patientID: String, error: Error)] = []
        for patientID in patientIDs {
            do {
                try await registerDeviceToken(patientID: patientID, deviceID: deviceID, pushToken: pushToken, appVersion: appVersion)
            } catch {
                failures.append((patientID, error))
            }
        }
        return failures
    }
}
