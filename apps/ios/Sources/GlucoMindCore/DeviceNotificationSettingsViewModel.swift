import Foundation

/// "Powiadomienia" in Settings: which optional pushes this phone gets for the patient (rescue carbs alerts,
/// rescue-carbs.v1, off by default; the push when an answer is ready and the low reservoir push, on by default). Stored on the server per registered device, so it applies to this phone only.
@MainActor
public final class DeviceNotificationSettingsViewModel: ObservableObject {
    @Published public private(set) var rescueCarbAlertsEnabled = false
    @Published public private(set) var answerReadyPushEnabled = true
    @Published public private(set) var reservoirPushEnabled = true
    /// The server has the reservoir push (an older one sends no such switch).
    @Published public private(set) var hasReservoirPush = false
    /// The current value was read: the toggle can be used.
    @Published public private(set) var isLoaded = false
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSaving = false
    @Published public private(set) var errorMessage: String?

    public static let notRegisteredMessage = "Najpierw zezwól na powiadomienia"

    private let apiClient: APIClient
    private let patientID: String
    private let deviceID: String
    /// Registers this phone's push token again (the server answers 404 for a device it does not know yet).
    private let registerDevice: () async -> Void

    public init(apiClient: APIClient, patientID: String, deviceID: String, registerDevice: @escaping () async -> Void = {}) {
        self.apiClient = apiClient
        self.patientID = patientID
        self.deviceID = deviceID
        self.registerDevice = registerDevice
    }

    public func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let settings = try await registeredDevice {
                try await apiClient.getDeviceNotificationSettings(patientID: patientID, deviceID: deviceID)
            }
            apply(settings)
            isLoaded = true
            errorMessage = nil
        } catch {
            isLoaded = false
            errorMessage = Self.message(for: error, loading: true)
        }
    }

    /// "Ostrzeżenia o możliwym hipo": shown at once, put back when the server did not store it.
    public func setRescueCarbAlertsEnabled(_ enabled: Bool) async {
        guard isLoaded, !isSaving, enabled != rescueCarbAlertsEnabled else { return }
        await save(previous: rescueCarbAlertsEnabled, set: { self.rescueCarbAlertsEnabled = $0 }, to: enabled) {
            try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, rescueCarbAlertsEnabled: enabled)
        }
    }

    /// "Gotowa odpowiedź": shown at once, put back when the server did not store it.
    public func setAnswerReadyPushEnabled(_ enabled: Bool) async {
        guard isLoaded, !isSaving, enabled != answerReadyPushEnabled else { return }
        await save(previous: answerReadyPushEnabled, set: { self.answerReadyPushEnabled = $0 }, to: enabled) {
            try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, answerReadyPushEnabled: enabled)
        }
    }

    /// "Zbiornik insuliny": shown at once, put back when the server did not store it.
    public func setReservoirPushEnabled(_ enabled: Bool) async {
        guard isLoaded, !isSaving, enabled != reservoirPushEnabled else { return }
        await save(previous: reservoirPushEnabled, set: { self.reservoirPushEnabled = $0 }, to: enabled) {
            try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, reservoirPushEnabled: enabled)
        }
    }

    private func save(previous: Bool, set: (Bool) -> Void, to enabled: Bool, call: () async throws -> DeviceNotificationSettings) async {
        set(enabled)
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            apply(try await registeredDevice(call))
        } catch {
            set(previous)
            errorMessage = Self.message(for: error, loading: false)
        }
    }

    private func apply(_ settings: DeviceNotificationSettings) {
        rescueCarbAlertsEnabled = settings.rescue_carb_alerts_enabled
        answerReadyPushEnabled = settings.answer_ready_push_enabled
        if let reservoir = settings.reservoir_push_enabled {
            reservoirPushEnabled = reservoir
            hasReservoirPush = true
        }
    }

    /// Runs the call; on 404 registers the phone again and tries once more.
    private func registeredDevice(_ call: () async throws -> DeviceNotificationSettings) async throws -> DeviceNotificationSettings {
        do {
            return try await call()
        } catch APIClientError.notFound {
            await registerDevice()
            return try await call()
        }
    }

    private static func message(for error: Error, loading: Bool) -> String {
        switch error {
        case APIClientError.notFound:
            return notRegisteredMessage
        case APIClientError.transport:
            return "Brak połączenia. Spróbuj ponownie."
        default:
            return loading ? "Nie udało się wczytać ustawienia." : "Nie udało się zapisać. Spróbuj ponownie."
        }
    }
}
