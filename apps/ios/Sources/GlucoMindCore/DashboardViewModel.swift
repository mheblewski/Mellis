import Foundation

/// How current the dashboard on screen is (stale-ui.v1, 2026-10-31). Only the glucose shows it: dimmed in place with a
/// spinner while refreshing after a return, dimmed with "nie udało się odświeżyć" when that refresh failed.
public enum DashboardFreshness: Equatable, Sendable {
    /// Read recently, or no reason to doubt it.
    case fresh
    /// The app came back (or the tab was shown again) after a while: the data on screen may be old and a refresh runs.
    case refreshing
    /// That refresh failed (or the data has been failing for a while): retried with backoff while the app is active.
    case failed

    public var dimsGlucose: Bool { self != .fresh }
}

/// The Dashboard tab's data, refreshed while the tab is visible. A failed refresh keeps the last data on screen, so its
/// ages keep growing and turn yellow/red as the data gets old.
///
/// The foreground flow (stale-ui.v1): `run()` is the tab's loop (started when the tab is on screen and the app active,
/// cancelled otherwise). When it starts after `inactivityThreshold` without a successful read, the glucose is shown as
/// `.refreshing` at once and a read starts immediately. A failed read is retried with `retryDelays` (2, 5, 10, 20, 30 s)
/// instead of waiting for the next CGM reading, and each read gives up after `requestTimeout`, so a connection that died
/// while the phone was locked cannot hold the screen for URLSession's default minute. Reads never overlap: a refresh
/// asked for while one runs (timer, pull, foreground, live stream reconnect) waits for that one.
@MainActor
public final class DashboardViewModel: ObservableObject {
    /// One constant for "the data may be old now": the app was away (or the tab hidden) for this long since the last
    /// successful read. Long enough that switching tabs for a moment does not dim anything, short enough that a phone
    /// picked up after a CGM interval (5 min) never shows an old value as if it were current.
    nonisolated public static let inactivityThreshold: TimeInterval = 90

    @Published public private(set) var dashboard: DashboardResponse?
    /// Not published: no view shows it, and every published change re-renders the whole screen (chart included).
    public private(set) var isLoading = false
    @Published public private(set) var errorMessage: String?
    /// Changes only on a return after inactivity and on its outcome, so it rarely re-renders the screen.
    @Published public private(set) var freshness: DashboardFreshness = .fresh
    /// The chart's visible span; the chart's data is DashboardChartStore's.
    @Published public var chartRange: DashboardChartRange = .threeHours
    /// When the last read succeeded (the clock's time).
    public private(set) var lastSuccessAt: Date?
    /// How many reads were started (tests: no duplicate loads).
    public private(set) var loadCount = 0

    private let fetch: @MainActor (String) async throws -> DashboardResponse
    private let patientID: String
    private let clock: () -> Date
    private let retryDelays: [Duration]
    private let requestTimeout: Duration
    private var inFlight: Task<Bool, Never>?

    public convenience init(apiClient: APIClient, patientID: String) {
        self.init(patientID: patientID, fetch: { try await apiClient.getDashboard(patientID: $0) })
    }

    /// Tests: a fetch of their own, a clock, short retry delays and timeout.
    public init(
        patientID: String,
        fetch: @escaping @MainActor (String) async throws -> DashboardResponse,
        clock: @escaping () -> Date = Date.init,
        retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(10), .seconds(20), .seconds(30)],
        requestTimeout: Duration = .seconds(15)
    ) {
        self.patientID = patientID
        self.fetch = fetch
        self.clock = clock
        self.retryDelays = retryDelays.isEmpty ? [.seconds(5)] : retryDelays
        self.requestTimeout = requestTimeout
    }

    public static let failureMessage = "Nie udało się odświeżyć danych"

    /// Reads the dashboard; joins the read already running instead of starting another. True when it succeeded.
    @discardableResult
    public func refresh() async -> Bool {
        if let inFlight { return await inFlight.value }
        let task = Task { [weak self] () -> Bool in
            guard let self else { return false }
            return await self.load()
        }
        inFlight = task
        let result = await task.value
        if inFlight == task { inFlight = nil }
        return result
    }

    /// Pull to refresh. SwiftUI cancels the refresh action's task when the screen updates during the gesture; the read
    /// runs in a task of its own (refresh()), so the gesture cannot cancel it.
    public func refreshFromPull() async {
        await refresh()
    }

    /// "Spróbuj ponownie" after a failed refresh: the spinner again, and a read at once.
    public func retryNow() async {
        if freshness == .failed { freshness = .refreshing }
        await refresh()
    }

    /// The app came to the foreground, the tab came on screen or the live stream reconnected: the data on screen is
    /// shown as possibly old when the last good read is older than `inactivityThreshold`.
    public func markStaleIfInactive() {
        guard dashboard != nil, freshness == .fresh else { return }
        guard let lastSuccessAt else { return }
        if clock().timeIntervalSince(lastSuccessAt) >= Self.inactivityThreshold {
            freshness = .refreshing
        }
    }

    /// A guaranteed read on return (every foreground transition and live stream reconnect, besides the tab's loop):
    /// dims a possibly old glucose and reads now; joins a read already running.
    public func refreshAfterReturn() async {
        markStaleIfInactive()
        await refresh()
    }

    /// The tab's loop while it is on screen and the app active: a read now, then shortly after each expected CGM
    /// reading; after a failure again within seconds (backoff). Cancelling it (background, tab hidden) also stops the
    /// read in flight, so no request is left hanging over a suspension.
    public func run() async {
        markStaleIfInactive()
        await withTaskCancellationHandler {
            var failures = 0
            while !Task.isCancelled {
                let succeeded = await refresh()
                if Task.isCancelled { break }
                let delay: Duration
                if succeeded {
                    failures = 0
                    delay = Self.nextRefreshDelay(after: dashboard, now: clock())
                } else {
                    failures += 1
                    delay = retryDelays[min(failures, retryDelays.count) - 1]
                }
                try? await Task.sleep(for: delay)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelInFlight() }
        }
    }

    /// Kept for callers of the earlier name.
    public func refreshPeriodically() async {
        await run()
    }

    private func cancelInFlight() {
        inFlight?.cancel()
        inFlight = nil
    }

    private func load() async -> Bool {
        loadCount += 1
        isLoading = true
        defer { isLoading = false }
        do {
            let fresh = try await withTimeout(requestTimeout) { [fetch, patientID] in try await fetch(patientID) }
            // Unchanged data (a refresh between two CGM readings) does not re-render the screen.
            if !fresh.hasSameData(as: dashboard) { dashboard = fresh }
            lastSuccessAt = clock()
            if errorMessage != nil { errorMessage = nil }
            if freshness != .fresh { freshness = .fresh }
            return true
        } catch where Self.isCancellation(error) {
            // Cancelled (the loop stopped for the background or a hidden tab, or SwiftUI cancelled a pull): nothing
            // failed and the data stays as it is; the next return reads again.
            return false
        } catch {
            NSLog("[DASHBOARD] refresh failed: %@", String(describing: error))
            if errorMessage != Self.failureMessage { errorMessage = Self.failureMessage }
            // After a return, or once the last good read is older than the threshold: the glucose stays dimmed.
            let old = lastSuccessAt.map { clock().timeIntervalSince($0) >= Self.inactivityThreshold } ?? true
            if dashboard != nil, freshness == .refreshing || old { freshness = .failed }
            return false
        }
    }

    /// The read, or DashboardTimeout once `limit` passes (the request is cancelled then).
    private func withTimeout(_ limit: Duration, _ operation: @escaping @MainActor () async throws -> DashboardResponse) async throws -> DashboardResponse {
        try await withThrowingTaskGroup(of: DashboardResponse?.self) { group in
            group.addTask { @MainActor in try await operation() }
            group.addTask {
                try await Task.sleep(for: limit)
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next(), let response = first else { throw DashboardTimeout() }
            return response
        }
    }

    /// A cancelled request is not a failed one: Swift's CancellationError or URLSession's -999.
    nonisolated static func isCancellation(_ error: Error) -> Bool {
        error.isRequestCancellation
    }

    /// The CGM sends a reading every 5 minutes (1 for some sensors) and the loop app needs a few seconds to upload it, so
    /// the next refresh comes 15 s after the expected reading; a late reading is checked for every 20 s. At least once a
    /// minute anyway, so the ages and the pump's last contact stay current.
    nonisolated public static func nextRefreshDelay(after dashboard: DashboardResponse?, now: Date) -> Duration {
        let times = (dashboard?.readings ?? []).suffix(2).compactMap { DashboardDate.parse($0.at) }
        guard let latest = times.last else { return .seconds(30) }
        let interval = times.count == 2 ? min(max(latest.timeIntervalSince(times[0]), 60), 300) : 300
        let wait = latest.addingTimeInterval(interval + 15).timeIntervalSince(now)
        let seconds = wait > 0 ? min(wait, 60) : 20
        return .milliseconds(Int(max(seconds, 5) * 1_000))
    }
}

/// The dashboard read took longer than the view model's timeout.
public struct DashboardTimeout: Error, Equatable {}
