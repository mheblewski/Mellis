import Foundation

/// The Bolus tab's empty-form check read ahead while the app is open (owner 2026-11-15: the dose must be ready within a
/// few seconds of typing the carbs). The tab opens with the glucose, IOB, COB, the ICR and the chart already there and
/// waits only for the check of the typed carbs; a check younger than `RemoteBolusViewModel.previewMaxAge` stands in for
/// the tab's first one.
@MainActor
public final class BolusCheckPrefetch {
    public static let shared = BolusCheckPrefetch()

    public struct Entry {
        public let preview: RemoteCommandPreview
        public let at: Date
    }

    /// Read again this often while the app is open and the Bolus tab is not on screen (inside the tab's 2-minute limit).
    public static let interval: TimeInterval = 100

    private var entries: [String: Entry] = [:]
    private var inFlight: Set<String> = []

    public init() {}

    /// The newest check of this patient's empty form, if it is young enough for the tab to show and slide on.
    public func fresh(patientID: String, now: Date = Date(), maxAge: TimeInterval = RemoteBolusViewModel.previewMaxAge) -> Entry? {
        guard let entry = entries[patientID.lowercased()], now.timeIntervalSince(entry.at) <= maxAge, now >= entry.at else { return nil }
        return entry
    }

    /// The tab's own check of the empty form: kept for the next opening.
    public func store(_ preview: RemoteCommandPreview, patientID: String, at: Date = Date()) {
        guard preview.carbs_g == 0, preview.insulin_u == 0 else { return }
        entries[patientID.lowercased()] = Entry(preview: preview, at: at)
    }

    /// One read of the empty form (no second one while it is on its way); a failure keeps the last one.
    public func refresh(patientID: String, api: RemoteCommandsAPI, bolusStep: Decimal) async {
        let key = patientID.lowercased()
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        let started = Date()
        guard let preview = try? await api.previewRemoteCommand(patientID: patientID, carbsG: 0, insulinU: nil, bolusStep: bolusStep, mealInMinutes: nil, proposalID: nil, source: .bolusScreen, plannedBolusID: nil, timing: nil) else { return }
        store(preview, patientID: patientID, at: started)
        if let schedule = preview.icr_schedule {
            IcrScheduleStore.shared.save(IcrScheduleStore.Saved(schedule: schedule, pumpBolusStep: preview.pumpBolusStep, savedAt: started), patientID: patientID)
        }
    }

    public func clear() {
        entries = [:]
    }
}
