import SwiftUI
import GlucoMindCore

// The spotlight tour's drawing (the state machine is SpotlightTour in GlucoMindCore). Each element a tour can point at
// is marked with `.tourAnchor(id)`: its frame on screen (window coordinates) goes to TourAnchorFrames. The dim, the
// cut-out and the callout are drawn ONCE, at the app's root (SpotlightRootOverlay, over the TabView and the navigation
// bar): nothing under it moves when the tour starts, and the top bar and the tab bar are dimmed in place like the rest.
// Reusable: Dashboard or Rozmowy only mark their elements and start their own steps on the shared controller.

/// The frames of the marked elements, in window coordinates.
@MainActor
final class TourAnchorFrames: ObservableObject {
    @Published private(set) var frames: [String: CGRect] = [:]

    func set(_ id: String, _ frame: CGRect?) {
        guard frames[id] != frame else { return }
        frames[id] = frame
    }
}

/// The tour on screen, shared by the screen that runs it and the root overlay that draws it.
@MainActor
final class SpotlightTourController: ObservableObject {
    @Published var tour: SpotlightTour?
    /// The current step's element is a sample (the callout says "Przykład").
    @Published var sampleStep = false
    var isAvailable: (String) -> Bool = { _ in true }
    /// "Gotowe", "Pomiń", or the last step's element missing: the screen ends its tour.
    var onEnd: (SpotlightTour.Outcome) -> Void = { _ in }
}

private struct TourAnchorFramesKey: EnvironmentKey {
    static let defaultValue: TourAnchorFrames? = nil
}

extension EnvironmentValues {
    var tourAnchorFrames: TourAnchorFrames? {
        get { self[TourAnchorFramesKey.self] }
        set { self[TourAnchorFramesKey.self] = newValue }
    }
}

private struct TourAnchorModifier: ViewModifier {
    let id: String
    @Environment(\.tourAnchorFrames) private var frames

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in frames?.set(id, frame) }
            .onDisappear { frames?.set(id, nil) }
    }
}

extension View {
    /// Marks this view as the element a tour step with this id points at.
    func tourAnchor(_ id: String) -> some View {
        modifier(TourAnchorModifier(id: id))
    }

    func tourAnchor(_ step: BolusTourStep) -> some View {
        tourAnchor(step.rawValue)
    }
}

/// At the app's root, over everything (the navigation bar and the tab bar included): the tour, when one is on.
struct SpotlightRootOverlay: View {
    @ObservedObject var controller: SpotlightTourController
    @ObservedObject var frames: TourAnchorFrames

    var body: some View {
        if controller.tour?.isActive == true {
            SpotlightTourOverlay(
                tour: $controller.tour,
                anchorFrames: frames,
                sampleStep: controller.sampleStep,
                isAvailable: controller.isAvailable,
                onEnd: { controller.onEnd($0) }
            )
            .ignoresSafeArea()
            .transition(.opacity)
        }
    }
}

/// The dim with a rounded hole: drawn with the even-odd rule, the hole animatable so it glides between steps.
struct SpotlightCutoutShape: Shape {
    var hole: CGRect
    var cornerRadius: CGFloat

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(AnimatablePair(hole.origin.x, hole.origin.y), AnimatablePair(hole.size.width, hole.size.height)) }
        set {
            hole = CGRect(x: newValue.first.first, y: newValue.first.second, width: newValue.second.first, height: newValue.second.second)
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        if hole.width > 0, hole.height > 0 {
            path.addRoundedRect(in: hole, cornerSize: CGSize(width: cornerRadius, height: cornerRadius), style: .continuous)
        }
        return path
    }
}

struct SpotlightTourOverlay: View {
    @Binding var tour: SpotlightTour?
    /// The marked elements, in window coordinates (an object: the wait for a missing element reads it live).
    @ObservedObject var anchorFrames: TourAnchorFrames
    private var frames: [String: CGRect] { anchorFrames.frames }
    let sampleStep: Bool
    let isAvailable: (String) -> Bool
    let onEnd: (SpotlightTour.Outcome) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var nextFocused: Bool
    /// The callout's natural height at its width (measured on a hidden copy), for its placement.
    @State private var calloutHeight: CGFloat = 160

    private static let padding: CGFloat = 8
    private static let cornerRadius: CGFloat = 16

    var body: some View {
        GeometryReader { proxy in
            let step = tour?.current
            // The overlay covers the window (it ignores the safe area): window coordinates less its own origin.
            let origin = proxy.frame(in: .global).origin
            let target = step.flatMap { frames[$0.id] }.map { $0.offsetBy(dx: -origin.x, dy: -origin.y).insetBy(dx: -Self.padding, dy: -Self.padding) }
            // Before the element is laid out (a sample appearing, a scroll): the callout in the middle, no hole.
            let hole = target ?? CGRect(x: proxy.size.width / 2, y: proxy.size.height / 2, width: 0, height: 0)
            // The callout stays inside the safe area (not under the status bar or the home indicator).
            let insets = proxy.safeAreaInsets
            let safe = CGSize(width: proxy.size.width - insets.leading - insets.trailing, height: proxy.size.height - insets.top - insets.bottom)
            let placed = SpotlightCalloutPlacement.place(target: hole.offsetBy(dx: -insets.leading, dy: -insets.top), calloutHeight: calloutHeight, container: safe)
            let placement = SpotlightCalloutPlacement(edge: placed.edge, origin: CGPoint(x: placed.origin.x + insets.leading, y: placed.origin.y + insets.top), width: placed.width, maxHeight: placed.maxHeight)
            ZStack(alignment: .topLeading) {
                SpotlightCutoutShape(hole: hole, cornerRadius: Self.cornerRadius)
                    .fill(Color.black.opacity(0.6), style: FillStyle(eoFill: true))
                    .accessibilityHidden(true)
                // A ring round the hole, so it reads as pointed at also on a dark screen.
                if target != nil {
                    RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.85), lineWidth: 2)
                        .frame(width: hole.width, height: hole.height)
                        .offset(x: hole.minX, y: hole.minY)
                        .accessibilityHidden(true)
                }
                // Nothing under the overlay takes a tap while the tour is on (the hole, the top bar and the tab bar
                // included: the slider stays off).
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {}
                    .accessibilityHidden(true)
                if let step {
                    callout(step, maxHeight: placement.maxHeight)
                        .frame(width: placement.width)
                        .offset(x: placement.origin.x, y: placement.origin.y)
                        // The natural height, measured apart from the frame it is placed in.
                        .background(alignment: .topLeading) {
                            calloutContent(step)
                                .frame(width: placement.width)
                                .fixedSize(horizontal: false, vertical: true)
                                .hidden()
                                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { calloutHeight = $0 }
                                .accessibilityHidden(true)
                        }
                }
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: hole)
            .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: placement)
        }
        .task(id: tour?.current?.id) {
            guard let id = tour?.current?.id else { return }
            // VoiceOver: "Dalej" gets the focus and the step's text is said after it.
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard !Task.isCancelled else { return }
            nextFocused = true
            if let text = tour?.current?.text {
                var announcement = AttributedString(text)
                announcement.accessibilitySpeechAnnouncementPriority = .high
                AccessibilityNotification.Announcement(announcement).post()
            }
            // The element never appeared (a layout without it): the tour goes on without that step.
            try? await Task.sleep(nanoseconds: 1_100_000_000)
            guard !Task.isCancelled, tour?.current?.id == id, anchorFrames.frames[id] == nil else { return }
            withAnimation { tour?.stepIsMissing(id, isAvailable: isAvailable) }
            if let outcome = tour?.outcome, tour?.isActive == false { onEnd(outcome) }
        }
    }

    private func callout(_ step: SpotlightTourStep, maxHeight: CGFloat) -> some View {
        ScrollView {
            calloutContent(step)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(calloutHeight, maxHeight))
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DashboardPalette.cardBackground))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
        .shadow(color: .black.opacity(0.25), radius: 16, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private func calloutContent(_ step: SpotlightTourStep) -> some View {
        let last = tour?.isLast(isAvailable: isAvailable) ?? true
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(tour?.progressText(isAvailable: isAvailable) ?? "")
                    .font(.footnote.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(progressLabel)
                if sampleStep {
                    Text("Przykład")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.interactive)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Brand.interactive.opacity(0.14)))
                        .accessibilityLabel("Przykładowe dane, tylko w przewodniku")
                }
                Spacer(minLength: 0)
            }
            Text(step.text)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .id(step.id)
                .transition(.opacity)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    skipButton
                    Spacer(minLength: 0)
                    nextButton(last: last)
                }
                VStack(alignment: .leading, spacing: 8) {
                    nextButton(last: last)
                    skipButton
                }
            }
        }
        .padding(16)
    }

    private var progressLabel: String {
        guard let progress = tour?.progress(isAvailable: isAvailable) else { return "" }
        return "Krok \(progress.position) z \(progress.total)"
    }

    private var skipButton: some View {
        Button("Pomiń") {
            tour?.skip()
            onEnd(.skipped)
        }
        .font(.body)
        .foregroundStyle(.secondary)
        .buttonStyle(.borderless)
        .accessibilityHint("Zamyka przewodnik")
        .accessibilityIdentifier("tour.skip")
    }

    private func nextButton(last: Bool) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.35)) { tour?.next(isAvailable: isAvailable) }
            if let tour, !tour.isActive, let outcome = tour.outcome { onEnd(outcome) }
        } label: {
            Text(last ? "Gotowe" : "Dalej")
                .font(.body.weight(.semibold))
                .padding(.horizontal, 8)
        }
        .buttonStyle(.borderedProminent)
        .tint(Brand.interactive)
        .accessibilityFocused($nextFocused)
        .accessibilityIdentifier(last ? "tour.done" : "tour.next")
    }
}
