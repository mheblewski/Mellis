import Foundation
import GlucoMindCore
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// The glucose Live Activity on this phone (live-activity.v1): on while "Glukoza na ekranie blokady" is on, for one or
/// two patients (migration 094). The app starts the first activity itself; the server keeps it current with a push for
/// every reading and starts the next one (push-to-start) before iOS ends it after 8 h. The app hands the server its
/// tokens and ends extra activities.
@MainActor
final class LiveActivityController: ObservableObject {
    static let shared = LiveActivityController()
    /// Two at most: side by side on the lock screen, one each side of the Dynamic Island.
    static let maxPatients = 2

    /// The switch, per phone.
    @Published private(set) var isEnabled: Bool
    /// The patients shown, in order (the first is the activity's own patient); names as when picked.
    @Published private(set) var patientIDs: [String]
    @Published private(set) var patientNames: [String]
    /// One patient, "Dynamic Island": true = "Glukoza i IOB" in the compact island, false = "Sama glukoza" (iOS cannot
    /// hide a running activity from the island, so this is the choice instead of an off switch).
    @Published private(set) var islandEnabled: Bool
    /// Two patients: "Oboje" or "Bliższe zagrożeniu".
    @Published private(set) var islandMode: LiveIslandMode
    /// "Oboje": the patient on the left; nil = the first.
    @Published private(set) var islandLeftPatientID: String?
    /// The phone does not allow Live Activities (Settings → GlucoMind → Live Activities).
    @Published private(set) var isBlockedBySystem = false
    @Published private(set) var errorMessage: String?

    private var apiClient: APIClient?
    private var deviceID: String { DeviceIDStore.shared.deviceID }
    private let defaults = UserDefaults.standard
    private var observers: [Task<Void, Never>] = []
    private var observedActivities = Set<String>()

    private enum Key {
        static let enabled = "live-activity.enabled"
        /// One patient (before two-patient activities); still read once to carry the choice over.
        static let patientID = "live-activity.patient-id"
        static let patientName = "live-activity.patient-name"
        static let patientIDs = "live-activity.patient-ids"
        static let patientNames = "live-activity.patient-names"
        static let islandEnabled = "live-activity.island-enabled"
        static let islandMode = "live-activity.island-mode"
        static let islandLeft = "live-activity.island-left"
    }

    private init() {
        let defaults = UserDefaults.standard
        isEnabled = defaults.bool(forKey: Key.enabled)
        if let ids = defaults.stringArray(forKey: Key.patientIDs), !ids.isEmpty {
            patientIDs = ids
            patientNames = defaults.stringArray(forKey: Key.patientNames) ?? []
        } else if let id = defaults.string(forKey: Key.patientID) {
            patientIDs = [id]
            patientNames = [defaults.string(forKey: Key.patientName) ?? ""]
        } else {
            patientIDs = []
            patientNames = []
        }
        islandEnabled = defaults.object(forKey: Key.islandEnabled) as? Bool ?? true
        islandMode = defaults.string(forKey: Key.islandMode).flatMap(LiveIslandMode.init(rawValue:)) ?? .both
        islandLeftPatientID = defaults.string(forKey: Key.islandLeft)
    }

    private var patientID: String? { patientIDs.first }

    /// The first patient the lock screen shows (Settings → Ekran blokady); nil before it was ever switched on.
    var shownPatientID: String? { patientID }

    /// "Zosia" or "Zosia i Kuba" (Settings' subtitle).
    var shownNames: String? {
        let names = patientNames.filter { !$0.isEmpty }
        return names.isEmpty ? nil : names.joined(separator: " i ")
    }

    /// Called once signed in: picks up running activities and their tokens again.
    func configure(apiClient: APIClient) {
        self.apiClient = apiClient
        #if canImport(ActivityKit) && os(iOS)
        isBlockedBySystem = !ActivityAuthorizationInfo().areActivitiesEnabled
        guard isEnabled else { return }
        startObserving()
        #endif
    }

    /// "Glukoza na ekranie blokady" turned on (for the patients picked, or the patient on screen) or off.
    func setEnabled(_ enabled: Bool, patient: AccessiblePatient) async {
        await setEnabled(enabled, patients: [patient])
    }

    func setEnabled(_ enabled: Bool, patients: [AccessiblePatient]) async {
        errorMessage = nil
        #if canImport(ActivityKit) && os(iOS)
        if enabled {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                isBlockedBySystem = true
                return
            }
            let previousPatient = patientID
            remember(patients: Array(patients.prefix(Self.maxPatients)))
            defaults.set(true, forKey: Key.enabled)
            isEnabled = true
            if previousPatient != nil, previousPatient != patientID { await endAll() }
            await send(LiveActivityChange(enabled: true, islandEnabled: islandEnabled, patientIDs: patientIDs, islandMode: islandMode,
                                          islandLeftPatientID: islandLeftPatientID.map { .set($0) } ?? .clear))
            startObserving()
            if activities.isEmpty {
                await startIfNone()
            } else {
                await refreshRunning()
            }
        } else {
            defaults.set(false, forKey: Key.enabled)
            isEnabled = false
            await send(LiveActivityChange(enabled: false))
            stopObserving()
            await endAll()
        }
        #endif
    }

    /// The patients picked in Settings (one or two, in order). Another first patient starts a new activity (its
    /// attributes name the first patient); otherwise the running one changes at once.
    func setPatients(_ patients: [AccessiblePatient]) async {
        guard !patients.isEmpty else { return }
        guard isEnabled else {
            remember(patients: Array(patients.prefix(Self.maxPatients)))
            return
        }
        await setEnabled(true, patients: patients)
    }

    /// "Dynamic Island" picked: the running activity changes at once, the server's next pushes keep it.
    func setIslandEnabled(_ shows: Bool) async {
        errorMessage = nil
        defaults.set(shows, forKey: Key.islandEnabled)
        islandEnabled = shows
        await send(LiveActivityChange(islandEnabled: shows))
        #if canImport(ActivityKit) && os(iOS)
        for activity in activities {
            var state = activity.content.state
            state.islandEnabled = shows
            await activity.update(ActivityContent(state: state, staleDate: state.staleDate))
        }
        #endif
    }

    /// Two patients: "Oboje" or "Bliższe zagrożeniu".
    func setIslandMode(_ mode: LiveIslandMode) async {
        errorMessage = nil
        defaults.set(mode.rawValue, forKey: Key.islandMode)
        islandMode = mode
        await send(LiveActivityChange(islandMode: mode))
        await updateRunning { $0.islandMode = mode.rawValue }
    }

    /// "Oboje": which patient is on the left.
    func setIslandLeft(_ patientID: String) async {
        errorMessage = nil
        defaults.set(patientID, forKey: Key.islandLeft)
        islandLeftPatientID = patientID
        await send(LiveActivityChange(islandLeftPatientID: .set(patientID)))
        await updateRunning { $0.islandLeft = patientID }
    }

    /// The app came to the foreground: an activity iOS ended (or one swiped away long ago) comes back at once.
    func appBecameActive() async {
        #if canImport(ActivityKit) && os(iOS)
        isBlockedBySystem = !ActivityAuthorizationInfo().areActivitiesEnabled
        guard isEnabled, apiClient != nil else { return }
        await startIfNone()
        #endif
    }

    /// Signed out: nothing of the caregiver stays on the lock screen, and whoever signs in next switches it on anew
    /// (the server already skips this phone: its device rows are gone).
    func signedOut() async {
        stopObserving()
        defaults.set(false, forKey: Key.enabled)
        isEnabled = false
        #if canImport(ActivityKit) && os(iOS)
        await endAll()
        #endif
    }

    private func remember(patients: [AccessiblePatient]) {
        patientIDs = patients.map(\.patient_id)
        patientNames = patients.map(\.display_name)
        defaults.set(patientIDs, forKey: Key.patientIDs)
        defaults.set(patientNames, forKey: Key.patientNames)
        defaults.set(patientIDs.first, forKey: Key.patientID)
        defaults.set(patientNames.first, forKey: Key.patientName)
        if let left = islandLeftPatientID, !patientIDs.contains(where: { $0.lowercased() == left.lowercased() }) {
            islandLeftPatientID = nil
            defaults.removeObject(forKey: Key.islandLeft)
        }
    }

    private func updateRunning(_ change: (inout GlucoseActivityState) -> Void) async {
        #if canImport(ActivityKit) && os(iOS)
        for activity in activities {
            var state = activity.content.state
            change(&state)
            await activity.update(ActivityContent(state: state, staleDate: state.staleDate))
        }
        #endif
    }

    private func send(_ change: LiveActivityChange) async {
        guard let apiClient, let patientID else { return }
        do {
            try await apiClient.setLiveActivity(patientID: patientID, deviceID: deviceID, change: change)
        } catch {
            NSLog("[LIVE-ACTIVITY] server update failed: %@", String(describing: error))
            errorMessage = "Nie udało się zapisać na serwerze (\(Self.reason(error))). Spróbuj ponownie."
        }
    }

    /// A short cause under the message, so a failure on a phone can be told apart without its logs.
    private static func reason(_ error: Error) -> String {
        switch error as? APIClientError {
        case let .unauthenticated(problem): return "401 \(problem?.code ?? "")"
        case let .forbidden(problem): return "403 \(problem?.code ?? "")"
        case let .notFound(problem): return "404 \(problem?.code ?? "")"
        case let .conflict(problem): return "409 \(problem?.code ?? "")"
        case let .validation(problem): return "400 \(problem?.title ?? "")"
        case let .server(problem): return "\(problem?.status ?? 500) \(problem?.code ?? "")"
        case let .transport(message): return "sieć: \(message.prefix(80))"
        case let .unexpectedStatus(status, _): return "HTTP \(status)"
        case .invalidResponse: return "zła odpowiedź"
        case nil: return String(String(describing: error).prefix(80))
        }
    }

    private func stopObserving() {
        observers.forEach { $0.cancel() }
        observers.removeAll()
        observedActivities.removeAll()
    }

    #if canImport(ActivityKit) && os(iOS)
    private var activities: [Activity<GlucoseActivityAttributes>] {
        Activity<GlucoseActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }

    /// Starts one from the dashboards when none runs (the server's pushes take over from there).
    private func startIfNone() async {
        guard activities.isEmpty, let patientID else { return }
        do {
            guard let content = try await currentContent() else { return }
            let attributes = GlucoseActivityAttributes(patientID: patientID, patientName: patientNames.first ?? "")
            let activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
            observe(activity)
        } catch {
            NSLog("[LIVE-ACTIVITY] start failed: %@", String(describing: error))
            errorMessage = "Nie udało się pokazać glukozy na ekranie blokady (\(Self.reason(error)))."
        }
    }

    /// The running activity shows the patients picked now (another second patient, one patient again).
    private func refreshRunning() async {
        guard !activities.isEmpty else { return }
        do {
            guard let content = try await currentContent() else { return }
            for activity in activities {
                await activity.update(content)
            }
        } catch {
            NSLog("[LIVE-ACTIVITY] refresh failed: %@", String(describing: error))
        }
    }

    /// The content for the patients picked, from their dashboards (two patients: no chart, as the server sends it).
    private func currentContent() async throws -> ActivityContent<GlucoseActivityState>? {
        guard let apiClient, let patientID else { return nil }
        let now = Date()
        let dashboard = try await apiClient.getDashboard(patientID: patientID)
        var state = GlucoseActivityState(dashboard: dashboard, now: now, islandEnabled: islandEnabled)
        if patientIDs.count > 1 {
            let secondID = patientIDs[1]
            // A second patient that cannot be read now is left out until the server's next push.
            if let second = try? await apiClient.getDashboard(patientID: secondID) {
                let glance = GlucoseActivityPatient(id: secondID, name: patientNames.count > 1 ? patientNames[1] : "", dashboard: second)
                state = state.adding(second: glance, firstID: patientID, firstName: patientNames.first ?? "", mode: islandMode, left: islandLeftPatientID)
            }
        }
        // Stale when the newest reading shown is (the widgets' 16 min, StaleReading), as the server's pushes say.
        return ActivityContent(state: state, staleDate: state.staleDate)
    }

    private func startObserving() {
        guard observers.isEmpty else { return }
        for activity in Activity<GlucoseActivityAttributes>.activities { observe(activity) }
        // Activities the server starts with push-to-start appear here, also while the app runs in the background.
        observers.append(Task { [weak self] in
            for await activity in Activity<GlucoseActivityAttributes>.activityUpdates {
                await self?.observe(activity)
                await self?.endAllBut(activity)
            }
        })
        if #available(iOS 17.2, *) {
            observers.append(Task { [weak self] in
                for await token in Activity<GlucoseActivityAttributes>.pushToStartTokenUpdates {
                    await self?.send(LiveActivityChange(startToken: .set(token.hexString)))
                }
            })
        }
    }

    private func observe(_ activity: Activity<GlucoseActivityAttributes>) {
        guard !observedActivities.contains(activity.id) else { return }
        observedActivities.insert(activity.id)
        let id = activity.id
        observers.append(Task { [weak self] in
            for await token in activity.pushTokenUpdates {
                await self?.send(LiveActivityChange(activityID: .set(id), updateToken: .set(token.hexString)))
            }
        })
        observers.append(Task { [weak self] in
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                await self?.activityEnded(id)
                break
            }
        })
    }

    /// Ended by iOS or swiped away: the server forgets its token (and waits a while before starting a new one).
    private func activityEnded(_ id: String) async {
        observedActivities.remove(id)
        guard isEnabled, !activities.contains(where: { $0.id != id }) else { return }
        await send(LiveActivityChange(activityID: .clear, updateToken: .clear))
    }

    /// Only the newest activity stays (a push-to-start replaced the older one).
    private func endAllBut(_ newest: Activity<GlucoseActivityAttributes>) async {
        for activity in activities where activity.id != newest.id {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private func endAll() async {
        for activity in Activity<GlucoseActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
    #endif
}

#if DEBUG && canImport(ActivityKit) && os(iOS)
/// Visual checks of the Live Activity on a simulator, no server: GLUCOMIND_LIVE_ACTIVITY_FIXTURE=<variant> in the
/// launch environment (`SIMCTL_CHILD_GLUCOMIND_LIVE_ACTIVITY_FIXTURE=due xcrun simctl launch …`) ends the running
/// activities and starts one with fixture content. Variants: normal (default), due (sensor due soon), alarm (low,
/// falling fast, site overdue), old (no reading for 25 min), empty (no readings, no IOB/COB), noisland ("Sama glukoza"
/// in the island). Two patients (Zosia 122 ↗ and Kuba): two (Kuba 64 ↓, "Oboje", Zosia left), two-right (the same,
/// Kuba left), two-closer ("Bliższe zagrożeniu": Kuba, low), two-closer-high (Kuba 268 ↑ vs Zosia 122: Kuba),
/// two-old (Kuba without a reading for 25 min).
enum LiveActivityFixture {
    static let environmentKey = "GLUCOMIND_LIVE_ACTIVITY_FIXTURE"

    @MainActor
    static func startIfRequested() async {
        guard let variant = ProcessInfo.processInfo.environment[environmentKey] else { return }
        for activity in Activity<GlucoseActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        let state = state(variant: variant, now: Date())
        let attributes = GlucoseActivityAttributes(patientID: firstID, patientName: DocsScreenshotNames.apply("Ania (podgląd)"))
        do {
            _ = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: state.staleDate), pushType: nil)
            NSLog("[LIVE-ACTIVITY] fixture %@ started", variant)
        } catch {
            NSLog("[LIVE-ACTIVITY] fixture %@ failed: %@", variant, String(describing: error))
        }
    }

    static let firstID = "00000000-0000-4000-8000-000000000001"
    static let secondID = "00000000-0000-4000-8000-000000000002"

    static func state(variant: String, now: Date) -> GlucoseActivityState {
        guard variant.hasPrefix("two") else { return onePatient(variant: variant, now: now) }
        let t = now.timeIntervalSince1970
        let first = onePatient(variant: "normal", now: now)
        let kuba = DocsScreenshotNames.apply("Kuba (podgląd)")
        let second: GlucoseActivityPatient
        switch variant {
        case "two-closer-high":
            second = GlucoseActivityPatient(id: secondID, name: kuba, glucose: 268, direction: "FortyFiveUp", delta: 5, readingAt: t - 2 * 60, iob: 2.1)
        case "two-old":
            second = GlucoseActivityPatient(id: secondID, name: kuba, glucose: 143, direction: "Flat", delta: 0, readingAt: t - 25 * 60, iob: 0.8)
        default:
            second = GlucoseActivityPatient(id: secondID, name: kuba, glucose: 64, direction: "SingleDown", delta: -6, readingAt: t - 1 * 60, iob: 0.42)
        }
        let mode: LiveIslandMode = variant.hasPrefix("two-closer") ? .closer : .both
        return first.adding(second: second, firstID: firstID, firstName: DocsScreenshotNames.apply("Ania (podgląd)"), mode: mode,
                            left: variant == "two-right" ? secondID : firstID)
    }

    private static func onePatient(variant: String, now: Date) -> GlucoseActivityState {
        let t = now.timeIntervalSince1970
        let readingAge: Double = variant == "old" ? 25 * 60 : 3 * 60
        let last = t - readingAge
        // 2 h of readings every 5 min, ending at the newest one.
        let shape: (Double) -> Double
        switch variant {
        case "alarm": shape = { step in 150 - 88 * pow(step, 1.6) }          // 150 → 62
        default: shape = { step in 118 + 30 * sin(step * 3.4) + 12 * step }   // in range, ends ~122
        }
        let readings: [[Double]] = variant == "empty" ? [] : (0...24).map { i in
            let step = Double(i) / 24
            return [last - Double(24 - i) * 300, shape(step).rounded()]
        }
        let glucose = variant == "empty" ? nil : readings.last.map { Int($0[1]) }
        let hours: (Double) -> Double = { t - $0 * 3_600 }
        return GlucoseActivityState(
            glucose: glucose,
            direction: variant == "alarm" ? "DoubleDown" : "FortyFiveUp",
            delta: variant == "alarm" ? -9 : 4,
            readingAt: variant == "empty" ? nil : last,
            iob: variant == "empty" ? nil : (variant == "alarm" ? 0.4 : 1.35),
            cob: variant == "empty" ? nil : (variant == "alarm" ? 0 : 18),
            reservoir: 112,
            reservoirFull: 200,
            battery: 80,
            siteChangedAt: hours(variant == "alarm" ? 80 : 20),
            sensorStartedAt: hours(variant == "due" ? 230 : 60),
            readings: readings,
            boluses: variant == "empty" ? [] : [[t - 95 * 60, 2.5], [t - 40 * 60, 0.3]],
            islandEnabled: variant != "noisland"
        )
    }
}
#endif

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
