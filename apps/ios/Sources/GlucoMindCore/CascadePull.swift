import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The dashboard's pull to refresh, in place of the system refresh control (which held the
/// content at the spinner's height while waiting and moved it as one block). The cards follow the finger with springs
/// of their own and fold back in a cascade at once on release; the refresh runs on its own and shows as a small spinner
/// in a fixed slot of the screen (PullRefreshSpinner), never in the top bar.
public struct PullState: Equatable {
    public var offset: CGFloat = 0
    public var dragging = false

    public init(offset: CGFloat = 0, dragging: Bool = false) {
        self.offset = offset
        self.dragging = dragging
    }
}

/// Hold it as plain `@State` (not `@StateObject`) in the screen: the screen must not observe it, so a drag frame
/// re-renders only the thin wrappers that move the cards, never the cards' contents.
@MainActor
public final class PullModel: ObservableObject {
    @Published public var state = PullState()
    @Published public var triggered = false
    /// Waiting for the server after a pull. Kept in its own object: the spinner (next to the glucose value or the
    /// meals title, where an update is costly) must not re-render on every drag frame.
    public let activity = PullActivity()

    public var refreshing: Bool {
        get { activity.refreshing }
        set { if activity.refreshing != newValue { activity.refreshing = newValue } }
    }

    /// Another gesture owns the finger (the dashboard chart scrolling or selecting): pull to refresh stays put. Not
    /// published, only read by the gesture.
    public var isSuppressed = false

    /// Pulled this far (after rubber-banding), the cards trigger a refresh.
    nonisolated public static let threshold: CGFloat = 64

    public init() {}

    /// The finger pulled `distance` points past the top.
    public func drag(distance: CGFloat, onRefresh: @escaping @MainActor () async -> Void) {
        // A new drag: the ring of the previous one (kept full while it faded out) starts empty again.
        if !state.dragging {
            if triggered { triggered = false }
            Self.prepareHaptic()
        }
        guard distance > 0 else {
            if state.offset != 0 || !state.dragging { state = PullState(offset: 0, dragging: true) }
            return
        }
        // Half points only: smaller changes would re-render the wrappers without visible movement.
        let offset = (Self.rubberBand(distance) * 2).rounded() / 2
        if offset != state.offset || !state.dragging {
            state = PullState(offset: offset, dragging: true)
        }
        if offset >= Self.threshold, !triggered {
            triggered = true
            Self.haptic()
            refresh(onRefresh)
        }
    }

    /// For a list that keeps its own bounce (the meals tab): `overscroll` is how far the content is pulled past its
    /// top, as the scroll view shows it. The refresh starts once it passes `threshold` while the finger is down; after
    /// release the ring just follows the bounce back.
    ///
    /// The spinner shows at once, as on the dashboard (it re-renders only itself). The data waits until the list has
    /// bounced back: it would otherwise re-render the list while the finger still pulls, which shows as a hitch right
    /// after the tap.
    public func track(overscroll: CGFloat, interacting: Bool, threshold: CGFloat, onRefresh: @escaping @MainActor () async -> Void) {
        let offset = (max(0, overscroll) * 2).rounded() / 2
        if interacting {
            if !state.dragging, offset > 0 {
                if triggered { triggered = false }
                Self.prepareHaptic()
            }
            if state != PullState(offset: offset, dragging: true) { state = PullState(offset: offset, dragging: true) }
            if offset >= threshold, !triggered {
                triggered = true
                Self.haptic()
                if !refreshing {
                    refreshing = true
                    pendingRefresh = onRefresh
                }
            }
        } else {
            if state != PullState(offset: offset, dragging: false) {
                state = PullState(offset: offset, dragging: false)
            }
            if let work = pendingRefresh {
                pendingRefresh = nil
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(350))
                    await self?.perform(work)
                }
            }
        }
    }

    /// A refresh triggered while the finger is still down (lists; its spinner already shows), started once it lifts.
    private var pendingRefresh: (@MainActor () async -> Void)?

    /// The finger lifted: the cards go back at once; a running refresh carries on. A ring that reached the refresh
    /// point stays full (blue, arrow up) while it fades out with the cards; one that did not empties as it goes.
    public func release() {
        if state != PullState() { state = PullState() }
    }

    /// Runs in its own task so releasing the finger never waits for it. The spinner stays at least briefly, and a light
    /// tap says when the data is in.
    public func refresh(_ work: @escaping @MainActor () async -> Void) {
        guard !refreshing else { return }
        refreshing = true
        Task { @MainActor in
            await perform(work)
        }
    }

    /// The refresh with `refreshing` already set (the spinner showing).
    private func perform(_ work: @MainActor () async -> Void) async {
        let started = Date()
        await work()
        let shown = Date().timeIntervalSince(started)
        if shown < 0.6 {
            try? await Task.sleep(for: .milliseconds(Int((0.6 - shown) * 1_000)))
        }
        refreshing = false
        Self.doneHaptic()
    }

    /// Resists more the further it goes, like a scroll view's bounce.
    public static func rubberBand(_ distance: CGFloat) -> CGFloat {
        let limit: CGFloat = 150
        return limit * (1 - 1 / (distance * 0.55 / limit + 1))
    }

    #if canImport(UIKit)
    /// One generator, prepared when a pull starts, so the tap at the refresh point costs nothing on that frame.
    private static let feedback = UIImpactFeedbackGenerator(style: .light)
    #endif

    private static func prepareHaptic() {
        #if canImport(UIKit)
        feedback.prepare()
        #endif
    }

    private static func haptic() {
        #if canImport(UIKit)
        feedback.impactOccurred()
        #endif
    }

    private static func doneHaptic() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }
}

/// Each card follows the pull with its own spring. While the finger is down the lower cards trail a touch and travel a
/// little further (the gaps open like an accordion); after release the top card settles first and every lower one a
/// little later and softer, so they fold back into place one after another.
public struct PullCascade: ViewModifier {
    let pull: PullState
    /// 0 for the top card, growing downwards (fractions stagger cards within a row).
    let step: Double

    public static func animation(step: Double, dragging: Bool) -> Animation {
        dragging
            ? .interactiveSpring(response: 0.1 + 0.035 * step, dampingFraction: 0.86)
            : .spring(response: 0.34 + 0.1 * step, dampingFraction: 0.68)
    }

    public func body(content: Content) -> some View {
        content
            .offset(y: pull.offset * (1 + 0.07 * step))
            .animation(Self.animation(step: step, dragging: pull.dragging), value: pull)
    }
}

/// Re-renders on every drag frame, but only to move `content`: the wrapped card's own body is not evaluated again.
private struct PullCascadeItem<Content: View>: View {
    @ObservedObject var pull: PullModel
    let step: Double
    let content: Content

    var body: some View {
        content.modifier(PullCascade(pull: pull.state, step: step))
    }
}

public extension View {
    func pullCascade(_ pull: PullModel, step: Double) -> some View {
        PullCascadeItem(pull: pull, step: step, content: self)
    }
}

/// The ring in the gap that opens above the top card: fills while pulling, full (blue) once a refresh started.
public struct PullIndicator: View {
    @ObservedObject var pull: PullModel
    let threshold: CGFloat
    /// True when the offset comes from a scroll view's own bounce (every frame): no spring of its own then.
    let followsScroll: Bool

    public init(pull: PullModel, threshold: CGFloat = PullModel.threshold, followsScroll: Bool = false) {
        self.pull = pull
        self.threshold = threshold
        self.followsScroll = followsScroll
    }

    private static let accent = Brand.interactive

    public var body: some View {
        let progress = min(max(pull.state.offset / threshold, 0), 1)
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.2), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: pull.triggered ? 1 : progress)
                .stroke(pull.triggered ? Self.accent : Color.secondary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: "arrow.down")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(pull.triggered ? Self.accent : Color.secondary)
                .rotationEffect(.degrees(pull.triggered ? 180 : 0))
        }
        .frame(width: 22, height: 22)
        .animation(.easeOut(duration: 0.15), value: pull.triggered)
        // Centred in the gap above the top card.
        .offset(y: pull.state.offset / 2 - 11)
        .opacity(Double(min(1, pull.state.offset / 30)))
        .animation(followsScroll ? nil : PullCascade.animation(step: 0, dragging: pull.state.dragging), value: pull.state.offset)
        .allowsHitTesting(false)
    }
}

@MainActor
public final class PullActivity: ObservableObject {
    @Published public var refreshing = false
}

/// A spinner while waiting for the server after a pull. Its slot is always there, so appearing and disappearing
/// never moves anything around it.
public struct PullRefreshSpinner: View {
    @ObservedObject var activity: PullActivity
    let size: ControlSize

    public init(pull: PullModel, size: ControlSize = .regular) {
        self.activity = pull.activity
        self.size = size
    }

    public var body: some View {
        ZStack {
            if activity.refreshing {
                ProgressView()
                    .controlSize(size)
                    .transition(.opacity.combined(with: .scale(scale: 0.6)))
                    .accessibilityLabel("Odświeżam")
            }
        }
        .frame(width: slot, height: slot)
        .animation(.easeInOut(duration: 0.2), value: activity.refreshing)
    }

    private var slot: CGFloat {
        switch size {
        case .mini, .small: 22
        case .regular: 28
        default: 40
        }
    }
}

/// A list keeps its own scrolling and bounce, but instead of the system refresh control (which held the list at the
/// spinner's height) the pull shows the ring (in the gap that opens above the list) and starts the refresh in its own
/// task.
/// Needs iOS 18 to read the scroll position; on iOS 17 the list keeps the system refresh control.
public struct ListPullToRefresh: ViewModifier {
    let pull: PullModel
    let threshold: CGFloat
    let onRefresh: @MainActor () async -> Void
    @State private var insetTop: CGFloat = 0
    @State private var finger = ScrollFinger()


    public init(pull: PullModel, threshold: CGFloat, onRefresh: @escaping @MainActor () async -> Void) {
        self.pull = pull
        self.threshold = threshold
        self.onRefresh = onRefresh
    }

    public func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content
                .onScrollGeometryChange(for: ListPullGeometry.self) { geometry in
                    ListPullGeometry(overscroll: -(geometry.contentOffset.y + geometry.contentInsets.top), insetTop: geometry.contentInsets.top)
                } action: { _, geometry in
                    // Only at rest: a change while pulling would re-render the list's modifier every frame.
                    if geometry.overscroll <= 0, abs(geometry.insetTop - insetTop) > 0.5 { insetTop = geometry.insetTop }
                    pull.track(overscroll: geometry.overscroll, interacting: finger.isDown, threshold: threshold, onRefresh: onRefresh)
                }
                #if canImport(UIKit)
                .background(ScrollFingerHook(finger: finger) { isDown in
                    if !isDown {
                        pull.track(overscroll: pull.state.offset, interacting: false, threshold: threshold, onRefresh: onRefresh)
                    }
                })
                #endif
                .overlay(alignment: .top) {
                    PullIndicator(pull: pull, threshold: threshold, followsScroll: true)
                        // The gap opens at the list's top inset, right under the top bar.
                        .padding(.top, insetTop)
                        .ignoresSafeArea(edges: .top)
                }
        } else {
            content.refreshable { await onRefresh() }
        }
    }
}

struct ListPullGeometry: Equatable {
    let overscroll: CGFloat
    let insetTop: CGFloat
}

/// Whether a finger is on the list (SwiftUI's scroll phase does not report it for a List).
@MainActor
final class ScrollFinger {
    var isDown = false
}

#if canImport(UIKit)
/// Finds the nearest scroll view (the List's collection view) and follows its pan gesture; changes nothing about it.
struct ScrollFingerHook: UIViewRepresentable {
    let finger: ScrollFinger
    let onChange: @MainActor (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(finger: finger, onChange: onChange)
    }

    func makeUIView(context: Context) -> HookView {
        let view = HookView()
        view.isUserInteractionEnabled = false
        view.coordinator = context.coordinator
        return view
    }

    func updateUIView(_ view: HookView, context: Context) {
        context.coordinator.onChange = onChange
    }

    final class HookView: UIView {
        weak var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            // The list's collection view may be created after this view: try again shortly.
            coordinator?.attach(from: self)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self else { return }
                self.coordinator?.attach(from: self)
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject {
        let finger: ScrollFinger
        var onChange: @MainActor (Bool) -> Void
        private weak var scrollView: UIScrollView?

        init(finger: ScrollFinger, onChange: @escaping @MainActor (Bool) -> Void) {
            self.finger = finger
            self.onChange = onChange
        }

        func attach(from view: UIView) {
            guard scrollView == nil, let found = Self.nearestScrollView(from: view) else { return }
            scrollView = found
            found.panGestureRecognizer.addTarget(self, action: #selector(handlePan(_:)))
        }

        /// Walks up from `view` and searches each ancestor's subtree, so the closest scroll view wins.
        private static func nearestScrollView(from view: UIView) -> UIScrollView? {
            var ancestor = view.superview
            while let current = ancestor {
                var queue = current.subviews
                while !queue.isEmpty {
                    let next = queue.removeFirst()
                    if let scrollView = next as? UIScrollView { return scrollView }
                    queue.append(contentsOf: next.subviews)
                }
                ancestor = current.superview
            }
            return nil
        }

        @objc private func handlePan(_ pan: UIPanGestureRecognizer) {
            let isDown: Bool
            switch pan.state {
            case .began, .changed: isDown = true
            default: isDown = false
            }
            guard isDown != finger.isDown else { return }
            finger.isDown = isDown
            onChange(isDown)
        }
    }
}
#endif
