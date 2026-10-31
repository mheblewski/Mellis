import Foundation
import SwiftUI

/// One look for a glucose that is not current (stale-ui.v1, 2026-10-31), shared by the home widgets, the Live Activity
/// and the dashboard: the background stays as it is (no red wash), the value and its trend arrow are dimmed in place
/// (grey, see-through), and the time since the reading ("23 min temu") is red. A stale reading is one older than the
/// dashboard's red reading-age threshold (DashboardThresholds.readingAge, over 15 min); on the dashboard also one whose
/// refresh is running or failed after the app came back.
public enum StaleReading {
    /// How see-through the dimmed value and arrow are.
    public static let dimOpacity = 0.4

    /// No new reading for longer than the dashboard's red reading age (over 15 min): one threshold everywhere.
    public static func isStale(minutes: Int) -> Bool {
        DashboardThresholds.readingAge(minutes: minutes) == .alarm
    }

    public static func isStale(observedAt: Date?, now: Date) -> Bool {
        guard let observedAt else { return true }
        return isStale(minutes: DashboardFormat.wholeMinutes(since: observedAt, now: now))
    }

    /// How long after it was taken a reading turns stale: over 15 whole minutes = from 16:00 on (isStale). The Live
    /// Activity's stale date and the server's (LIVE_ACTIVITY_STALE_AFTER_SECONDS, live-activity-state.ts) use it, so the
    /// activity dims when the widgets do.
    public static let staleAfterSeconds: TimeInterval = 16 * 60

    /// When a reading taken at `observedAt` turns stale; nil without a reading.
    public static func staleDate(observedAt: Date?) -> Date? {
        observedAt?.addingTimeInterval(staleAfterSeconds)
    }

    /// "23 min temu", "1 h 5 min temu", "2 d temu": the age that is shown in red once the reading is stale.
    public static func ageText(minutes: Int) -> String {
        let minutes = max(0, minutes)
        if minutes < 1 { return "teraz" }
        if minutes < 60 { return "\(minutes) min temu" }
        if minutes < 24 * 60 {
            let rest = minutes % 60
            return rest == 0 ? "\(minutes / 60) h temu" : "\(minutes / 60) h \(rest) min temu"
        }
        return "\(minutes / (24 * 60)) d temu"
    }
}

public extension View {
    /// The stale glucose: grey and see-through, in place (no change of size, so nothing around it moves).
    func staleDimmed(_ stale: Bool) -> some View {
        grayscale(stale ? 1 : 0)
            .opacity(stale ? StaleReading.dimOpacity : 1)
    }
}
