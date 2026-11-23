import Foundation

/// "Godziny ciszy" of this phone (quiet-hours.v1, docs/product/quiet-hours-plan.md): hours in which Mellis sends no
/// glucose pushes to it, holds equipment pushes until the end and lets the low warnings through. One setting for the
/// phone, read and saved through any patient it is registered for.
public struct QuietHoursSettings: Codable, Equatable {
    public var enabled: Bool
    /// Minutes after local midnight; an end before the start means the next day.
    public var start_minute: Int
    public var end_minute: Int
    public var time_zone: String
    /// "Ostrzeżenia o niedocukrzeniu" in quiet hours.
    public var low_warnings: Bool

    public init(enabled: Bool = false, start_minute: Int = 22 * 60, end_minute: Int = 7 * 60, time_zone: String = TimeZone.current.identifier, low_warnings: Bool = true) {
        self.enabled = enabled
        self.start_minute = start_minute
        self.end_minute = end_minute
        self.time_zone = time_zone
        self.low_warnings = low_warnings
    }

    /// "22:00–7:00" (the row's value), or "Wyłączone".
    public var summary: String {
        enabled ? "\(QuietHoursSettings.clock(start_minute))–\(QuietHoursSettings.clock(end_minute))" : "Wyłączone"
    }

    /// VoiceOver: "od 22:00 do 7:00".
    public var spokenSummary: String {
        enabled ? "od \(QuietHoursSettings.clock(start_minute)) do \(QuietHoursSettings.clock(end_minute))" : "wyłączone"
    }

    /// The end is on the next day ("następnego dnia" next to "Do").
    public var endsNextDay: Bool { end_minute <= start_minute }

    /// "7:00", "22:30".
    public static func clock(_ minute: Int) -> String {
        "\(minute / 60):\(String(format: "%02d", minute % 60))"
    }

    /// Whether `date` falls in the quiet hours, in the stored zone (the moon by the bell).
    public func contains(_ date: Date) -> Bool {
        guard enabled, start_minute != end_minute else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: time_zone) ?? .current
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        return start_minute < end_minute ? (minute >= start_minute && minute < end_minute) : (minute >= start_minute || minute < end_minute)
    }
}

/// The fields to change (nil = left as it is).
public struct QuietHoursChange: Encodable, Equatable {
    public var enabled: Bool?
    public var start: Int?
    public var end: Int?
    public var time_zone: String?
    public var low_warnings: Bool?

    public init(enabled: Bool? = nil, start: Int? = nil, end: Int? = nil, time_zone: String? = nil, low_warnings: Bool? = nil) {
        self.enabled = enabled
        self.start = start
        self.end = end
        self.time_zone = time_zone
        self.low_warnings = low_warnings
    }
}

/// The "Godziny ciszy" screen: shown at once, put back when the server did not store it. Every save sends the phone's
/// time zone, so a trip abroad moves the hours with the phone.
@MainActor
public final class QuietHoursViewModel: ObservableObject {
    @Published public private(set) var settings = QuietHoursSettings()
    @Published public private(set) var isLoaded = false
    @Published public private(set) var isSaving = false
    @Published public private(set) var errorMessage: String?
    /// The server has no quiet hours (an older one): the row is hidden.
    @Published public private(set) var isUnavailable = false

    private let apiClient: APIClient
    private let patientID: String
    private let deviceID: String
    private let registerDevice: () async -> Void
    private let timeZone: () -> String

    public init(apiClient: APIClient, patientID: String, deviceID: String, registerDevice: @escaping () async -> Void = {}, timeZone: @escaping () -> String = { TimeZone.current.identifier }) {
        self.apiClient = apiClient
        self.patientID = patientID
        self.deviceID = deviceID
        self.registerDevice = registerDevice
        self.timeZone = timeZone
    }

    public func load() async {
        do {
            settings = try await registered { try await apiClient.getQuietHours(patientID: patientID, deviceID: deviceID) }
            isLoaded = true
            isUnavailable = false
            errorMessage = nil
            QuietHoursStore.remember(settings)
        } catch APIClientError.notFound {
            // An older server answers 404 for the path itself as well: treat it as no quiet hours.
            isUnavailable = true
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    public func setEnabled(_ enabled: Bool) async { await change(QuietHoursChange(enabled: enabled)) { $0.enabled = enabled } }
    public func setStart(_ minute: Int) async { await change(QuietHoursChange(start: minute)) { $0.start_minute = minute } }
    public func setEnd(_ minute: Int) async { await change(QuietHoursChange(end: minute)) { $0.end_minute = minute } }
    public func setLowWarnings(_ on: Bool) async { await change(QuietHoursChange(low_warnings: on)) { $0.low_warnings = on } }

    /// Same start and end: refused here, as on the server.
    public var startEqualsEnd: Bool { settings.start_minute == settings.end_minute }

    private func change(_ change: QuietHoursChange, apply: (inout QuietHoursSettings) -> Void) async {
        guard isLoaded else { return }
        let previous = settings
        var next = settings
        apply(&next)
        if next.enabled && next.start_minute == next.end_minute {
            settings = next
            errorMessage = "Początek i koniec muszą się różnić."
            return
        }
        settings = next
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        var body = change
        body.time_zone = timeZone()
        // A fixed start/end pair: when one of them was refused before, both go now.
        if change.start != nil || change.end != nil { body.start = next.start_minute; body.end = next.end_minute }
        do {
            settings = try await registered { try await apiClient.setQuietHours(patientID: patientID, deviceID: deviceID, change: body) }
            QuietHoursStore.remember(settings)
        } catch {
            settings = previous
            errorMessage = Self.message(for: error)
        }
    }

    /// The phone's zone changed (a trip): stored again if quiet hours are on.
    public func syncTimeZone() async {
        guard isLoaded, settings.enabled, settings.time_zone != timeZone() else { return }
        await change(QuietHoursChange()) { $0.time_zone = timeZone() }
    }

    private func registered(_ call: () async throws -> QuietHoursSettings) async throws -> QuietHoursSettings {
        do {
            return try await call()
        } catch APIClientError.notFound {
            await registerDevice()
            return try await call()
        }
    }

    private static func message(for error: Error) -> String {
        if case APIClientError.transport = error { return "Brak połączenia. Spróbuj ponownie." }
        return "Nie udało się zapisać. Spróbuj ponownie."
    }
}

/// The last quiet hours read or saved on this phone: the moon by the bell and the first-time sheet read it without a call.
public enum QuietHoursStore {
    private static let key = "quietHours.v1"
    private static let introKey = "quietHours.introShown"

    public static func remember(_ settings: QuietHoursSettings, defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(settings), forKey: key)
    }

    public static func current(defaults: UserDefaults = .standard) -> QuietHoursSettings? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(QuietHoursSettings.self, from: data)
    }

    /// The sheet "W tych godzinach Mellis nie powiadomi o glukozie…" comes once, the first time they are turned on.
    public static func introShown(defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: introKey) }
    public static func markIntroShown(defaults: UserDefaults = .standard) { defaults.set(true, forKey: introKey) }
}
