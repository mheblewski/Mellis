import SwiftUI
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
                    if WatchSession.usesFixtures { ComplicationGallery(now: context.date) }
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
            let states = WatchSample.states(now: now)
            ForEach([false, true], id: \.self) { tile in
                RectangularPairComplication(first: .reading(states[0].glance), second: .reading(WatchSample.glance(WatchSample.second, now: now)), now: now, tile: tile)
                    .frame(width: 184, height: tile ? 80 : 68)
                RectangularPairComplication(first: .reading(states[4].glance), second: .reading(states[6].glance), now: now, tile: tile)
                    .frame(width: 184, height: tile ? 80 : 68)
                RectangularPairComplication(first: .reading(states[3].glance), second: .reading(states[7].glance), now: now, tile: tile)
                    .frame(width: 184, height: tile ? 80 : 68)
            }
            InlinePairComplication(first: .reading(states[0].glance), second: .reading(WatchSample.glance(WatchSample.second, now: now)),
                                   initials: ["00000000-0000-0000-0000-00000000000a": "O", "00000000-0000-0000-0000-00000000000b": "M"], now: now)
                .font(.system(size: 13, weight: .semibold))
        }
    }
}
#endif
