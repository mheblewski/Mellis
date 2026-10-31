import AppIntents
import Foundation
import GlucoMindCore
import WidgetKit

/// "Pacjent" in the widget's settings (hold the widget → Edytuj widżet): one widget per patient. Without a choice the
/// widget shows the caregiver's first patient.
struct PatientEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Pacjent"
    static let defaultQuery = PatientQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct PatientQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [PatientEntity] {
        try await patients().filter { patient in identifiers.contains { $0.caseInsensitiveCompare(patient.id) == .orderedSame } }
    }

    func suggestedEntities() async throws -> [PatientEntity] {
        try await patients()
    }

    func defaultResult() async -> PatientEntity? {
        try? await patients().first
    }

    private func patients() async throws -> [PatientEntity] {
        if HomeWidgetAPI.usesFixtures {
            return [PatientEntity(id: HomeWidgetSample.patient.patient_id, name: HomeWidgetSample.patient.display_name)]
        }
        return try await HomeWidgetAPI.client().listAccessiblePatients().patients.map { PatientEntity(id: $0.patient_id, name: $0.display_name) }
    }
}

struct SelectPatientIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Pacjent"
    static let description = IntentDescription("Którego pacjenta pokazuje widżet.")

    @Parameter(title: "Pacjent")
    var patient: PatientEntity?

    init() {}
}

struct HomeWidgetEntry: TimelineEntry {
    enum State: Equatable {
        case data(patient: AccessiblePatient, dashboard: DashboardResponse)
        case signedOut
        case noPatient
        case failed
    }

    let date: Date
    let state: State
    /// The last read failed and the data is the cached copy (its age shows how old it is).
    var isCached = false
}

struct HomeWidgetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> HomeWidgetEntry {
        HomeWidgetEntry(date: .now, state: .data(patient: HomeWidgetSample.patient, dashboard: HomeWidgetSample.dashboard(now: .now)))
    }

    func snapshot(for configuration: SelectPatientIntent, in context: Context) async -> HomeWidgetEntry {
        // The widget gallery shows sample data at once; a widget already on the screen shows its patient.
        if context.isPreview { return placeholder(in: context) }
        return await read(configuration, now: .now)
    }

    func timeline(for configuration: SelectPatientIntent, in context: Context) async -> Timeline<HomeWidgetEntry> {
        let now = Date()
        let entry = await read(configuration, now: now)
        guard case let .data(_, dashboard) = entry.state else {
            return Timeline(entries: [entry], policy: .after(now.addingTimeInterval(15 * 60)))
        }
        let entries = HomeWidgetGlance.entryDates(dashboard, now: now).map {
            HomeWidgetEntry(date: $0, state: entry.state, isCached: entry.isCached)
        }
        return Timeline(entries: entries, policy: .after(HomeWidgetGlance.nextReload(after: dashboard, now: now)))
    }

    private func read(_ configuration: SelectPatientIntent, now: Date) async -> HomeWidgetEntry {
        if HomeWidgetAPI.usesFixtures {
            let age: TimeInterval = HomeWidgetAPI.fixtureIsStale ? 23 * 60 : 3 * 60
            return HomeWidgetEntry(date: now, state: .data(patient: HomeWidgetSample.patient, dashboard: HomeWidgetSample.dashboard(now: now, readingAge: age)))
        }
        let chosenID = configuration.patient?.id
        do {
            let client = try HomeWidgetAPI.client()
            let patient: AccessiblePatient
            if let chosen = configuration.patient {
                patient = AccessiblePatient(patient_id: chosen.id, display_name: chosen.name)
            } else {
                guard let first = try await client.listAccessiblePatients().patients.first else {
                    return HomeWidgetEntry(date: now, state: .noPatient)
                }
                patient = first
            }
            let dashboard = try await client.getDashboard(patientID: patient.patient_id)
            HomeWidgetCache.save(dashboard, patient: patient)
            return HomeWidgetEntry(date: now, state: .data(patient: patient, dashboard: dashboard))
        } catch {
            NSLog("[WIDGET] read failed: %@", String(describing: error))
            if case APIClientError.unauthenticated = error {
                return HomeWidgetEntry(date: now, state: .signedOut)
            }
            if let cached = HomeWidgetCache.load(patientID: chosenID) {
                return HomeWidgetEntry(date: now, state: .data(patient: cached.patient, dashboard: cached.dashboard), isCached: true)
            }
            return HomeWidgetEntry(date: now, state: .failed)
        }
    }
}
