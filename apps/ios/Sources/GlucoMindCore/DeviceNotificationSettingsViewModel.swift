import Foundation

/// "Powiadomienia" in Settings: which optional pushes this phone gets for the patient (rescue carbs alerts,
/// rescue-carbs.v1, off by default; the push when an answer is ready and the low reservoir push, on by default; glucose
/// pushes, glucose-alerts.v1, off by default). Stored on the server per registered device, so it applies to this phone only.
@MainActor
public final class DeviceNotificationSettingsViewModel: ObservableObject {
    @Published public private(set) var rescueCarbAlertsEnabled = false
    @Published public private(set) var answerReadyPushEnabled = true
    @Published public private(set) var reservoirPushEnabled = true
    /// The server has the reservoir push (an older one sends no such switch).
    @Published public private(set) var hasReservoirPush = false
    /// "Bateria pompy" (battery-alerts.v1), on by default; hidden when the server has no such push.
    @Published public private(set) var batteryPushEnabled = true
    @Published public private(set) var hasBatteryPush = false
    /// "Powiadomienia o glikemii" (glucose-alerts.v1), off by default, and the kinds turned off inside it.
    @Published public private(set) var glucoseAlertsEnabled = false
    @Published public private(set) var glucoseAlertKindsOff: Set<GlucoseAlertSetting> = []
    /// "Powtarzaj co" (minutes) for a low and for the other kinds.
    @Published public private(set) var glucoseAlertLowRepeatMinutes = GlucoseAlertRepeat.defaultLowMinutes
    @Published public private(set) var glucoseAlertRepeatMinutes = GlucoseAlertRepeat.defaultMinutes
    /// The server has glucose pushes (an older one sends no such switch).
    @Published public private(set) var hasGlucoseAlerts = false
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

    /// "Bateria pompy": shown at once, put back when the server did not store it.
    public func setBatteryPushEnabled(_ enabled: Bool) async {
        guard isLoaded, !isSaving, enabled != batteryPushEnabled else { return }
        await save(previous: batteryPushEnabled, set: { self.batteryPushEnabled = $0 }, to: enabled) {
            try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, batteryPushEnabled: enabled)
        }
    }

    /// "Powiadomienia o glikemii": shown at once, put back when the server did not store it.
    public func setGlucoseAlertsEnabled(_ enabled: Bool) async {
        guard isLoaded, !isSaving, enabled != glucoseAlertsEnabled else { return }
        await save(previous: glucoseAlertsEnabled, set: { self.glucoseAlertsEnabled = $0 }, to: enabled) {
            try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, glucoseAlertsEnabled: enabled)
        }
    }

    public func isGlucoseAlertOn(_ kind: GlucoseAlertSetting) -> Bool {
        !glucoseAlertKindsOff.contains(kind)
    }

    /// One kind inside "Powiadomienia o glikemii": shown at once, put back when the server did not store it.
    public func setGlucoseAlert(_ kind: GlucoseAlertSetting, enabled: Bool) async {
        guard isLoaded, !isSaving, enabled != isGlucoseAlertOn(kind) else { return }
        let previous = glucoseAlertKindsOff
        var next = previous
        if enabled { next.remove(kind) } else { next.insert(kind) }
        glucoseAlertKindsOff = next
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        let kindsOff = GlucoseAlertSetting.allCases.filter { next.contains($0) }.map(\.rawValue)
        do {
            apply(try await registeredDevice {
                try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, glucoseAlertKindsOff: kindsOff)
            })
        } catch {
            glucoseAlertKindsOff = previous
            errorMessage = Self.message(for: error, loading: false)
        }
    }

    /// "Powtarzaj co" for a low: shown at once, put back when the server did not store it.
    public func setGlucoseAlertLowRepeatMinutes(_ minutes: Int) async {
        guard isLoaded, !isSaving, minutes != glucoseAlertLowRepeatMinutes else { return }
        await saveMinutes(previous: glucoseAlertLowRepeatMinutes, set: { self.glucoseAlertLowRepeatMinutes = $0 }, to: minutes) {
            try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, glucoseAlertLowRepeatMinutes: minutes)
        }
    }

    /// "Powtarzaj co" for the other kinds: shown at once, put back when the server did not store it.
    public func setGlucoseAlertRepeatMinutes(_ minutes: Int) async {
        guard isLoaded, !isSaving, minutes != glucoseAlertRepeatMinutes else { return }
        await saveMinutes(previous: glucoseAlertRepeatMinutes, set: { self.glucoseAlertRepeatMinutes = $0 }, to: minutes) {
            try await self.apiClient.setDeviceNotificationSettings(patientID: self.patientID, deviceID: self.deviceID, glucoseAlertRepeatMinutes: minutes)
        }
    }

    private func saveMinutes(previous: Int, set: (Int) -> Void, to minutes: Int, call: () async throws -> DeviceNotificationSettings) async {
        set(minutes)
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
        if let battery = settings.battery_push_enabled {
            batteryPushEnabled = battery
            hasBatteryPush = true
        }
        if let glucose = settings.glucose_alerts_enabled {
            glucoseAlertsEnabled = glucose
            glucoseAlertKindsOff = Set((settings.glucose_alert_kinds_off ?? []).compactMap(GlucoseAlertSetting.init(rawValue:)))
            glucoseAlertLowRepeatMinutes = settings.glucose_alert_low_repeat_minutes ?? GlucoseAlertRepeat.defaultLowMinutes
            glucoseAlertRepeatMinutes = settings.glucose_alert_repeat_minutes ?? GlucoseAlertRepeat.defaultMinutes
            hasGlucoseAlerts = true
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
