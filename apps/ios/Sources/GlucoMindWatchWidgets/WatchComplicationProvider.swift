import Foundation
import WidgetKit

struct WatchComplicationEntry: TimelineEntry {
    let date: Date
    /// One patient, or two for the two-patient complication (the first two in the caregiver's list).
    let contents: [WatchComplicationContent]
    /// The patient letters, set when the caregiver has more than one patient.
    let initials: [String: String]

    var first: WatchComplicationContent { contents.first ?? .noPatient }
    var second: WatchComplicationContent { contents.count > 1 ? contents[1] : .noPatient }

    func initial(of content: WatchComplicationContent) -> String? {
        guard case let .reading(glance) = content else { return nil }
        return initials[glance.patient.id]
    }
}

/// Reads the patients' glances (one glance read for all) and lays out a minute-by-minute timeline from them, so the
/// age and the stale look stay right between reads.
enum WatchComplicationReader {
    static func entries(patientID: String?, count: Int, now: Date) async -> Timeline<WatchComplicationEntry> {
        let (contents, initials) = await read(patientID: patientID, count: count, now: now)
        let glances = contents.compactMap { content -> WatchGlance? in
            if case let .reading(glance) = content { return glance }
            return nil
        }
        guard !glances.isEmpty else {
            return Timeline(entries: [WatchComplicationEntry(date: now, contents: contents, initials: initials)],
                            policy: .after(now.addingTimeInterval(15 * 60)))
        }
        let entries = WatchTimeline.entryDates(glances, now: now).map { WatchComplicationEntry(date: $0, contents: contents, initials: initials) }
        return Timeline(entries: entries, policy: .after(WatchTimeline.nextReload(glances, now: now)))
    }

    static func read(patientID: String?, count: Int, now: Date) async -> ([WatchComplicationContent], [String: String]) {
        if WatchSession.usesFixtures {
            let patients = [WatchSample.first, WatchSample.second]
            let chosen = patients.filter { patientID == nil || $0.id == patientID }.prefix(count)
            return (chosen.map { .reading(WatchSample.glance($0, now: now)) }, WatchFormat.initials(patients))
        }
        do {
            let client = try WatchSession.client()
            let glances: [WatchGlance]
            do {
                glances = try await client.glances()
            } catch APIClientError.unauthenticated {
                // Revoked or replaced on the phone: the phone makes a new token (the watch app reports it when opened).
                return ([.signedOut], [:])
            }
            let patients = glances.map(\.patient)
            glances.forEach(WatchCache.save)
            if WatchCache.savePatients(patients) {
                WidgetCenter.shared.invalidateConfigurationRecommendations()
            }
            await WatchWidgetPush.registerIfNeeded(client: client)
            let chosen: [WatchGlance]
            if let patientID {
                chosen = glances.filter { $0.patient.id.caseInsensitiveCompare(patientID) == .orderedSame }
            } else {
                chosen = Array(glances.prefix(count))
            }
            guard !chosen.isEmpty else { return ([.noPatient], [:]) }
            let initials = patients.count > 1 ? WatchFormat.initials(patients) : [:]
            return (chosen.map(WatchComplicationContent.reading), initials)
        } catch {
            NSLog("[WATCH] read failed: %@", String(describing: error))
            if case WatchSession.Failure.signedOut = error { return ([.signedOut], [:]) }
            // No network: the cached readings, greyed by their age.
            let patients = WatchCache.patients
            let chosen = patientID.map { id in patients.filter { $0.id == id } } ?? Array(patients.prefix(count))
            let cached = chosen.compactMap { WatchCache.glance(patientID: $0.id) }.map(WatchComplicationContent.reading)
            return (cached.isEmpty ? [.unavailable] : cached, patients.count > 1 ? WatchFormat.initials(patients) : [:])
        }
    }
}

/// What the face editor shows before a complication is added: the patient it will really show, with their last reading
/// or else sample numbers. Never the sample names: they said one patient and the added complication another.
enum WatchPreview {
    static func glance(at index: Int, now: Date = .now) -> WatchGlance {
        let sample = index == 0 ? WatchSample.first : WatchSample.second
        guard !WatchSession.usesFixtures else { return WatchSample.glance(sample, now: now) }
        let patients = WatchCache.patients
        guard patients.indices.contains(index) else {
            let unknown = WatchPatient(id: sample.id, name: index == 0 ? "Pierwsza osoba" : "Druga osoba")
            return WatchSample.glance(unknown, now: now)
        }
        return WatchCache.glance(patientID: patients[index].id) ?? WatchSample.glance(patients[index], now: now)
    }
}

/// One patient by place in the caregiver's list (0 = first, 1 = second): each has its own complication in the face
/// editor, named after the patient. (watchOS kept offering a single "Glukoza" instead of the per-patient
/// recommendations of a configurable complication, so the choice is two complications.)
struct WatchIndexProvider: TimelineProvider {
    let index: Int

    func placeholder(in context: Context) -> WatchComplicationEntry {
        WatchComplicationEntry(date: .now, contents: [.reading(WatchPreview.glance(at: index))], initials: [:])
    }

    func getSnapshot(in context: Context, completion: @escaping (WatchComplicationEntry) -> Void) {
        if context.isPreview { return completion(placeholder(in: context)) }
        Task {
            guard let id = patientID else {
                return completion(WatchComplicationEntry(date: .now, contents: [.noPatient], initials: [:]))
            }
            let (contents, initials) = await WatchComplicationReader.read(patientID: id, count: 1, now: .now)
            completion(WatchComplicationEntry(date: .now, contents: contents, initials: initials))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchComplicationEntry>) -> Void) {
        Task {
            guard let id = patientID else {
                // No such patient (yet): look again in an hour, after a hand-over from the phone.
                let entry = WatchComplicationEntry(date: .now, contents: [.noPatient], initials: [:])
                return completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(3_600))))
            }
            completion(await WatchComplicationReader.entries(patientID: id, count: 1, now: .now))
        }
    }

    private var patientID: String? {
        let patients = WatchSession.usesFixtures ? [WatchSample.first, WatchSample.second] : WatchCache.patients
        return patients.indices.contains(index) ? patients[index].id : nil
    }
}

struct WatchPairProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchComplicationEntry {
        let glances = [WatchPreview.glance(at: 0), WatchPreview.glance(at: 1)]
        return WatchComplicationEntry(date: .now, contents: glances.map { .reading($0) },
                                      initials: WatchFormat.initials(glances.map(\.patient)))
    }

    func getSnapshot(in context: Context, completion: @escaping (WatchComplicationEntry) -> Void) {
        if context.isPreview { return completion(placeholder(in: context)) }
        Task {
            let (contents, initials) = await WatchComplicationReader.read(patientID: nil, count: 2, now: .now)
            completion(WatchComplicationEntry(date: .now, contents: contents, initials: initials))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchComplicationEntry>) -> Void) {
        Task { completion(await WatchComplicationReader.entries(patientID: nil, count: 2, now: .now)) }
    }
}
