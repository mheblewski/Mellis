import Foundation
import GlucoMindCore

/// The widget gallery's sample (and the simulator's, GM_WIDGET_FIXTURES): 6 h of readings rising after a bolus, one
/// item of equipment due soon.
enum HomeWidgetSample {
    static let patient = AccessiblePatient(patient_id: "8d2b1f0e-6a3c-4c1e-9f57-2a1b3c4d5e6f", display_name: "Zosia")

    /// `readingAge`: how old the newest reading is (3 min; 23 min for the stale look).
    static func dashboard(now: Date, readingAge: TimeInterval = 3 * 60) -> DashboardResponse {
        let last = now.addingTimeInterval(-readingAge)
        let values = [118, 124, 131, 140, 152, 161, 168, 171, 166, 158, 147, 133, 121, 112, 106, 101, 99, 98, 102, 109,
                      117, 124, 130, 134, 131, 126, 120, 114, 109, 106, 105, 108, 113, 119, 124, 128, 131, 133, 136, 138,
                      139, 137, 133, 128, 122, 117, 113, 110, 108, 107, 108, 111, 115, 119, 123, 126, 129, 132, 134, 136,
                      137, 138, 139, 139, 138, 136, 133, 131, 132, 135, 138, 142]
        let readings = values.enumerated().map { index, value in
            DashboardReading(at: iso(last.addingTimeInterval(-Double(values.count - 1 - index) * 300)), value: value)
        }
        return DashboardResponse(
            patient_id: patient.patient_id,
            generated_at: iso(now),
            glucose: DashboardGlucose(value: 142, unit: "mg/dL", direction: "FortyFiveUp", observed_at: iso(last), delta: 4),
            readings: readings,
            time_in_range: DashboardTimeInRange(hours: 24, readings_count: 280, low_percent: 2, in_range_percent: 78, high_percent: 20),
            pump: DashboardPump(battery_percent: 64, reservoir_units: 112, reservoir_full_units: 200, last_read_at: iso(now.addingTimeInterval(-120))),
            loop: DashboardLoop(iob_units: 1.35, cob_grams: 22, observed_at: iso(now.addingTimeInterval(-120))),
            insulin: DashboardInsulin(
                boluses: [DashboardDose(at: iso(now.addingTimeInterval(-4.6 * 3_600)), units: 4.5),
                          DashboardDose(at: iso(now.addingTimeInterval(-1.7 * 3_600)), units: 3.2)],
                smbs: [DashboardDose(at: iso(now.addingTimeInterval(-50 * 60)), units: 0.3),
                       DashboardDose(at: iso(now.addingTimeInterval(-25 * 60)), units: 0.2)],
                basal: []
            ),
            site_changed_at: iso(now.addingTimeInterval(-68 * 3_600)),
            sensor_started_at: iso(now.addingTimeInterval(-148 * 3_600))
        )
    }

    private static func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
