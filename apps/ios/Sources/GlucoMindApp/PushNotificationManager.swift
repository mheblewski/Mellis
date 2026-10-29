import Foundation
import UserNotifications
import GlucoMindCore

#if canImport(UIKit)
import UIKit

@MainActor
final class PushNotificationManager: NSObject {
    private let deviceID: String
    private let appVersion: String
    private let registrar: DeviceRegistrationService
    private let patientIDsProvider: () async throws -> [String]
    private var lastToken: String?

    /// This phone's APNs token, which Trio needs to answer a remote command.
    var currentToken: String? {
        lastToken
    }

    init(
        deviceID: String,
        appVersion: String,
        registrar: DeviceRegistrationService,
        patientIDsProvider: @escaping () async throws -> [String]
    ) {
        self.deviceID = deviceID
        self.appVersion = appVersion
        self.registrar = registrar
        self.patientIDsProvider = patientIDsProvider
        super.init()
    }

    func configureNotifications() async {
        NSLog("[APNS] configureNotifications entered device_id=%{public}@", deviceID)
        let center = UNUserNotificationCenter.current()
        NSLog("[APNS] UNUserNotificationCenter delegate expected from app lifecycle")
        // No action buttons: clears the loop action categories older builds registered.
        center.setNotificationCategories([])
        #if DEBUG
        // Screenshots in a fresh simulator: no permission prompt over the screen (GLUCOMIND_UI_FIXTURES_NO_PUSH=1).
        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_NO_PUSH"] == "1" { return }
        #endif

        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            NSLog("[APNS] requestAuthorization completed granted=%{public}@", granted ? "true" : "false")
            if granted {
                NSLog("[APNS] registerForRemoteNotifications call start")
                UIApplication.shared.registerForRemoteNotifications()
                NSLog("[APNS] registerForRemoteNotifications call end")
            }
        } catch {
            NSLog("[APNS] configureNotifications authorization error=%{public}@", String(describing: error))
            return
        }

        NSLog("[APNS] configureNotifications exit")
    }

    func registerReceivedDeviceToken(_ tokenData: Data) async {
        NSLog("[APNS] registerReceivedDeviceToken entered token_data_length=%{public}d", tokenData.count)
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        guard !token.isEmpty else {
            NSLog("[APNS] registerReceivedDeviceToken early-exit empty token")
            return
        }

        NSLog("[APNS] registerReceivedDeviceToken token conversion complete token_length=%{public}d", token.count)
        lastToken = token
        await registerLastToken()
    }

    /// Registers the last APNs token for every patient the signed-in caregiver can access. iOS hands the token out
    /// right after launch, often before sign-in or before the caregiver was given access to a patient (an empty list
    /// registers nothing), so this runs again after sign-in, after the patient list loads and on every foreground.
    func registerLastToken() async {
        guard let token = lastToken else {
            return
        }

        let patientIDs: [String]
        do {
            patientIDs = try await patientIDsProvider()
        } catch {
            NSLog("[APNS] registerDeviceToken patient list failure error=%{public}@", String(describing: error))
            return
        }
        if patientIDs.isEmpty {
            NSLog("[APNS] registerDeviceToken skipped: no accessible patient yet")
        }
        NSLog("[APNS] registerDeviceToken API call start patients=%{public}d device_id=%{public}@", patientIDs.count, deviceID)
        let failures = await registrar.registerDeviceToken(
            patientIDs: patientIDs,
            deviceID: deviceID,
            pushToken: token,
            appVersion: appVersion
        )
        for failure in failures {
            NSLog("[APNS] registerDeviceToken API call failure patient_id=%{public}@ error=%{public}@", failure.patientID, String(describing: failure.error))
        }
        if failures.isEmpty {
            NSLog("[APNS] registerDeviceToken API call success")
        }

        NSLog("[APNS] registerReceivedDeviceToken exit")
    }
}

#else
@MainActor
final class PushNotificationManager {
    init(
        deviceID: String,
        appVersion: String,
        registrar: DeviceRegistrationService,
        patientIDsProvider: @escaping () async throws -> [String]
    ) {
        _ = patientIDsProvider
    }

    var currentToken: String? { nil }

    func configureNotifications() async {}

    func registerReceivedDeviceToken(_ tokenData: Data) async {
        _ = tokenData
    }

    func registerLastToken() async {}
}
#endif
