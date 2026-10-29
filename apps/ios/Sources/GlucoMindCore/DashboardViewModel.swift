import Foundation

/// The Dashboard tab's data, refreshed while the tab is visible. A failed refresh keeps the last data on screen, so its
/// ages keep growing and turn yellow/red as the data gets old.
@MainActor
public final class DashboardViewModel: ObservableObject {
    @Published public private(set) var dashboard: DashboardResponse?
    /// Not published: no view shows it, and every published change re-renders the whole screen (chart included).
    public private(set) var isLoading = false
    @Published public private(set) var errorMessage: String?
    /// The chart's visible span; the chart's data is DashboardChartStore's.
    @Published public var chartRange: DashboardChartRange = .threeHours

    private let apiClient: APIClient
    private let patientID: String
    private var refreshGeneration = 0

    public init(apiClient: APIClient, patientID: String) {
        self.apiClient = apiClient
        self.patientID = patientID
    }

    public func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        isLoading = true
        defer {
            if generation == refreshGeneration { isLoading = false }
        }

        do {
            let fresh = try await apiClient.getDashboard(patientID: patientID)
            // Unchanged data (a refresh between two CGM readings) does not re-render the screen.
            if !fresh.hasSameData(as: dashboard) { dashboard = fresh }
            if errorMessage != nil { errorMessage = nil }
        } catch where Self.isCancellation(error) {
            return
        } catch {
            NSLog("[DASHBOARD] refresh failed: %@", String(describing: error))
            // A newer refresh (pull or timer) already runs or finished: its result is the one that counts.
            guard generation == refreshGeneration else { return }
            let message = "Nie udało się odświeżyć danych"
            if errorMessage != message { errorMessage = message }
        }
    }

    /// Pull to refresh. SwiftUI cancels the refresh action's task when the screen updates during the gesture, and
    /// URLSession reports that as an error; the request runs in its own task so the gesture cannot cancel it.
    public func refreshFromPull() async {
        await Task { await self.refresh() }.value
    }

    /// A cancelled request is not a failed one: Swift's CancellationError or URLSession's -999.
    nonisolated static func isCancellation(_ error: Error) -> Bool {
        error.isRequestCancellation
    }

    /// Refreshes now and then shortly after each expected CGM reading until the calling task is cancelled (the tab
    /// disappears).
    public func refreshPeriodically() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: Self.nextRefreshDelay(after: dashboard, now: Date()))
        }
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
