import SwiftUI
import WatchKit
import WidgetKit

@MainActor
final class WatchHomeModel: ObservableObject {
    enum State: Equatable {
        case loading
        case signedOut
        case noPatient
        case glances([WatchGlance])
        case failed
    }

    @Published private(set) var state: State = .loading
    @Published private(set) var now = Date()

    func sessionChanged() {
        Task { await refresh() }
    }

    func refresh() async {
        now = Date()
        // With the app on screen a reload does not count against the complications' budget (WidgetKit), so opening the
        // app also brings a complication up to date, or starts one that watchOS has not run yet.
        WidgetCenter.shared.reloadAllTimelines()
        if WatchSession.usesFixtures {
            state = .glances([WatchSample.glance(WatchSample.first, now: now), WatchSample.glance(WatchSample.second, now: now)])
            return
        }
        do {
            let client = try WatchSession.client()
            do {
                let glances = try await client.glances()
                glances.forEach(WatchCache.save)
                guard !glances.isEmpty else { state = .noPatient; return }
                state = .glances(glances)
                now = Date()
            } catch APIClientError.unauthenticated {
                // Revoked or replaced on the phone: the phone makes a new token.
                PhoneSessionReceiver.shared.reportRejected(fingerprint: client.tokenFingerprint)
                throw WatchSession.Failure.signedOut
            }
        } catch {
            if case WatchSession.Failure.signedOut = error {
                state = .signedOut
                PhoneSessionReceiver.shared.requestSession()
            } else if case .glances = state {
                // Keep what is shown; its age says how old it is.
            } else {
                state = .failed
            }
        }
    }
}

/// The watch app itself: each patient's reading as the rectangular complication shows it, for a look without a face
/// complication. Its main job is being the complications' home.
struct WatchHomeView: View {
    @ObservedObject var model: WatchHomeModel

    var body: some View {
        TimelineView(.everyMinute) { context in
            ScrollView {
                VStack(spacing: 8) {
                    switch model.state {
                    case .loading:
                        ProgressView()
                    case .signedOut:
                        message("Otwórz Mellis na iPhonie i zostaw ten ekran otwarty. Zegarek połączy się przez telefon.")
                    case .noPatient:
                        message("Na tym koncie nie ma jeszcze żadnego pacjenta.")
                    case .failed:
                        message("Nie udało się wczytać glukozy. Sprawdź połączenie.")
                    case .glances(let glances):
                        ForEach(glances, id: \.patient.id) { glance in
                            RectangularComplication(content: .reading(glance), now: context.date, tile: true)
                                .padding(10)
                                .frame(minHeight: 84)
                                .background(RoundedRectangle(cornerRadius: 16)
                                    .fill(WatchPalette.tileBackground(WatchReading(glance, now: context.date))))
                        }
                    }
                    #if DEBUG
                    if WatchSession.usesFixtures { ComplicationGallery(now: context.date).padding(.horizontal, -4) }
                    #endif
                    Text(Self.version).font(.caption2).foregroundStyle(.secondary).padding(.top, 4)
                }
                .padding(.horizontal, 4)
            }
        }
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
    }

    /// "Mellis 1.0.28 (1168)".
    static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return "Mellis \(info["CFBundleShortVersionString"] as? String ?? "") (\(info["CFBundleVersion"] as? String ?? ""))"
    }

    private func message(_ text: String) -> some View {
        VStack(spacing: 8) {
            Image("Logo").resizable().scaledToFit().frame(width: 36, height: 36)
            Text(text).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Odśwież") {
                PhoneSessionReceiver.shared.requestSession()
                Task { await model.refresh() }
            }
        }
    }
}

#if DEBUG
/// The simulator's look at every complication in every state (GM_WIDGET_FIXTURES builds only): real sizes of a 45 mm
/// watch. Outside a face the system parts (the circular's backdrop, the corner's curved label) are drawn by hand.
struct ComplicationGallery: View {
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("próba: \(Int(faceSize.width)) × \(Int(faceSize.height))").font(.caption2).foregroundStyle(.secondary)
            ForEach(tightCases, id: \.label) { item in
                Text(item.label).font(.caption2).foregroundStyle(.secondary)
                RectangularComplication(content: .reading(item.glance), now: now, tile: false)
                    .frame(width: faceSize.width, height: faceSize.height).border(Color.white.opacity(0.2))
                RectangularComplication(content: .reading(item.withoutHistory), now: now, tile: false)
                    .frame(width: faceSize.width, height: faceSize.height).border(Color.white.opacity(0.2))
                RectangularComplication(content: .reading(item.glance), now: now, tile: true)
                    .padding(8)
                    .frame(width: faceSize.width, height: faceSize.height)
                    .background(RoundedRectangle(cornerRadius: 12).fill(WatchPalette.tileBackground(WatchReading(item.glance, now: now))))
                RectangularComplication(content: .reading(item.withoutHistory), now: now, tile: true)
                    .padding(8)
                    .frame(width: faceSize.width, height: faceSize.height)
                    .background(RoundedRectangle(cornerRadius: 12).fill(WatchPalette.tileBackground(WatchReading(item.glance, now: now))))
                RectangularPairComplication(first: .reading(item.glance), second: .reading(item.glance), now: now, tile: false)
                    .frame(width: faceSize.width, height: faceSize.height).border(Color.white.opacity(0.2))
                RectangularPairColumnsComplication(first: .reading(item.glance), second: .reading(item.glance), now: now, tile: false)
                    .frame(width: faceSize.width, height: faceSize.height).border(Color.white.opacity(0.2))
                RectangularPairComplication(first: .reading(item.glance), second: .reading(item.glance), now: now, tile: true)
                    .frame(width: faceSize.width, height: faceSize.height)
                HStack(spacing: 6) {
                    CircularComplication(content: .reading(item.glance), initial: "O", now: now)
                        .frame(width: faceCircle, height: faceCircle)
                        .background(Circle().fill(Color.white.opacity(0.15)))
                        .clipShape(Circle())
                    CornerComplication(content: .reading(item.glance), initial: nil, now: now)
                        .frame(width: faceCircle * 0.76, height: faceCircle * 0.76)
                }
            }
            Text("dwie kolumny").font(.caption2).foregroundStyle(.secondary)
            ForEach(columnPairs, id: \.0) { label, first, second in
                Text(label).font(.caption2).foregroundStyle(.secondary)
                RectangularPairColumnsComplication(first: .reading(first), second: .reading(second), now: now, tile: false)
                    .frame(width: 184, height: 68)
                    .background(Color.black)
            }
            ForEach(WatchSample.states(now: now), id: \.label) { state in
                Text(state.label).font(.caption2).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    CircularComplication(content: .reading(state.glance), initial: "O", now: now)
                        .frame(width: 47, height: 47)
                        .background(Circle().fill(Color.white.opacity(0.15)))
                        .clipShape(Circle())
                    CornerComplication(content: .reading(state.glance), initial: nil, now: now)
                        .frame(width: 32, height: 32)
                    Spacer(minLength: 0)
                }
                RectangularComplication(content: .reading(state.glance), now: now, tile: false)
                    .frame(width: 184, height: 80, alignment: .topLeading)
                    .border(Color.white.opacity(0.15))
                RectangularComplication(content: .reading(state.glance), now: now, tile: true)
                    .padding(10)
                    .frame(width: 184, height: 80, alignment: .topLeading)
                    .background(RoundedRectangle(cornerRadius: 18).fill(WatchPalette.tileBackground(WatchReading(state.glance, now: now))))
                InlineComplication(content: .reading(state.glance), now: now)
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 150, alignment: .leading)
            }
            Text("dwie osoby").font(.caption2).foregroundStyle(.secondary)
            ForEach([false, true], id: \.self) { tile in
                ForEach(columnPairs, id: \.0) { _, first, second in
                    RectangularPairComplication(first: .reading(first), second: .reading(second), now: now, tile: tile)
                        .frame(width: 184, height: tile ? 80 : 68)
                }
            }
            InlinePairComplication(first: .reading(state("w zakresie")), second: .reading(WatchSample.glance(WatchSample.second, now: now)),
                                   initials: ["00000000-0000-0000-0000-00000000000a": "O", "00000000-0000-0000-0000-00000000000b": "M"], now: now)
                .font(.system(size: 13, weight: .semibold))
        }
    }

    /// The rectangular complication's size on this watch (Human Interface Guidelines, complications).
    private var faceSize: CGSize {
        let width = WKInterfaceDevice.current().screenBounds.width
        if width <= 162 { return CGSize(width: 162, height: 69) }
        if width <= 176 { return CGSize(width: 171.5, height: 73) }
        if width <= 184 { return CGSize(width: 184, height: 78) }
        return CGSize(width: 193, height: 82)
    }

    private var faceCircle: CGFloat {
        let width = WKInterfaceDevice.current().screenBounds.width
        return width <= 162 ? 42 : width <= 176 ? 44.5 : width <= 184 ? 47 : 50
    }

    /// The longest texts each state can have, with a long name.
    private var tightCases: [(label: String, glance: WatchGlance, withoutHistory: WatchGlance)] {
        let patient = WatchPatient(id: WatchSample.first.id, name: "Aleksandra Maria")
        func tight(_ label: String, _ value: Int?, _ direction: String?, _ delta: Int?, age: Double?) -> (label: String, glance: WatchGlance, withoutHistory: WatchGlance) {
            let observedAt = age.map { now.addingTimeInterval(-$0 * 60) }
            let history = value.flatMap { v in observedAt.map { WatchSample.sampleHistory(ending: v, at: $0, from: 150) } }
            return (label,
                    WatchGlance(patient: patient, value: value, direction: direction, delta: delta, observedAt: observedAt, iob: 3.45, cob: 120, history: history),
                    WatchGlance(patient: patient, value: value, direction: direction, delta: delta, observedAt: observedAt, iob: 3.45, cob: 120, history: nil))
        }
        return [
            tight("312, 11 min", 312, "DoubleUp", 112, age: 11),
            tight("48", 48, "DoubleDown", -12, age: 2),
            tight("stary", 288, "Flat", 1, age: 59),
            tight("brak", nil, nil, nil, age: nil),
        ]
    }

    private func state(_ label: String) -> WatchGlance {
        WatchSample.states(now: now).first { $0.label == label }!.glance
    }

    private var columnPairs: [(String, WatchGlance, WatchGlance)] {
        let second = WatchSample.glance(WatchSample.second, now: now)
        return [
            ("w zakresie", state("w zakresie"), second),
            ("powyżej 250 i poniżej 54", state("powyżej 250"), state("poniżej 54")),
            ("14 min i stary", state("14 min"), state("stary")),
            ("12 min i brak", state("12 min"), state("brak")),
            ("w zakresie i 90 min", state("w zakresie"), state("90 min")),
        ]
    }
}
#endif
