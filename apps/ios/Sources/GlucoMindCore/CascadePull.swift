import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The dashboard's pull to refresh, in place of the system refresh control (which held the
/// content at the spinner's height while waiting and moved it as one block). The cards follow the finger with springs
/// of their own and fold back in a cascade at once on release; the refresh runs on its own and shows as a small spinner
/// in a fixed slot of the screen (PullRefreshSpinner), never in the top bar.
public struct PullState: Equatable {
    /// How far the cards (or the list) moved down: the height of the gap the ring sits in.
    public var offset: CGFloat = 0
    /// How far the finger itself pulled past the top. The refresh point and the ring's progress go by this, so the
    /// same short pull refreshes on every screen, whatever resistance the cards or the list's bounce put up.
    public var travel: CGFloat = 0
    public var dragging = false

    public init(offset: CGFloat = 0, travel: CGFloat = 0, dragging: Bool = false) {
        self.offset = offset
        self.travel = travel
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
    /// A finger is down on the dashboard chart (from the touch, before the chart knows what it is): a sideways move
    /// there scrolls the chart and never changes the patient.
    public var touchesChart = false

    /// The finger pulled this far past the top (not the rubber-banded gap), a refresh starts: the same on the dashboard
    /// and the meals list. Measured on the gap it was 64 pt of cards (about 200 pt of finger) on the dashboard and 80 pt
    /// of the list's bounce (about 300 pt of finger) on the meals tab, out of reach with the month open.
    nonisolated public static let threshold: CGFloat = 110

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
        let travel = (distance * 2).rounded() / 2
        if offset != state.offset || travel != state.travel || !state.dragging {
            state = PullState(offset: offset, travel: travel, dragging: true)
        }
        if travel >= Self.threshold, !triggered {
            triggered = true
            Self.haptic()
            refresh(onRefresh)
        }
    }

    /// For a list that keeps its own bounce (the meals tab): `overscroll` is how far the content is pulled past its
    /// top, as the scroll view shows it, and `finger` the scroll view's pan translation while the finger is down. The
    /// refresh starts once the finger has pulled `threshold` past the top (counted from where the list reached its
    /// top); without a finger reading it falls back to the overscroll. After release the ring just follows the bounce
    /// back.
    ///
    /// The spinner shows at once, as on the dashboard (it re-renders only itself). The data waits until the list has
    /// bounced back: it would otherwise re-render the list while the finger still pulls, which shows as a hitch right
    /// after the tap.
    public func track(
        overscroll: CGFloat,
        finger: CGFloat? = nil,
        interacting: Bool,
        threshold: CGFloat = PullModel.threshold,
        onRefresh: @escaping @MainActor () async -> Void
    ) {
        let offset = (max(0, overscroll) * 2).rounded() / 2
        if interacting {
            if !state.dragging, offset > 0 {
                if triggered { triggered = false }
                Self.prepareHaptic()
            }
            let travel: CGFloat
            if let finger {
                // The finger may first scroll the list back to its top: only what it pulls after that counts. A pull
                // that starts with the list at its top reports no frame above it, so it counts from the pan's start.
                if offset <= 0 { fingerAtTop = finger }
                travel = (max(0, finger - (fingerAtTop ?? 0)) * 2).rounded() / 2
            } else {
                travel = offset
            }
            if offset > 0 { travelPerPoint = travel / offset }
            let next = PullState(offset: offset, travel: travel, dragging: true)
            if state != next { state = next }
            if travel >= threshold, !triggered {
                triggered = true
                Self.haptic()
                if !refreshing {
                    refreshing = true
                    pendingRefresh = onRefresh
                }
            }
        } else {
            fingerAtTop = nil
            // The ring empties along with the bounce, from where the finger left it.
            let next = PullState(offset: offset, travel: (offset * travelPerPoint * 2).rounded() / 2, dragging: false)
            if state != next { state = next }
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
    /// Lists: the finger's pan translation in the last frame the list was not past its top (nil: at its top all along).
    private var fingerAtTop: CGFloat?
    /// Lists: finger points per point of bounce in the last pull, so the ring empties with the bounce after release.
    private var travelPerPoint: CGFloat = 1

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

    /// How far the ring sits below the top of the gap: centred in it once the gap is taller than the ring, never above
    /// it (above the gap are the top bar and the Dynamic Island).
    nonisolated public static func ringOffset(gap: CGFloat) -> CGFloat {
        max(0, gap / 2 - size / 2)
    }

    nonisolated static let size: CGFloat = 22

    public var body: some View {
        let progress = min(max(pull.state.travel / threshold, 0), 1)
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
        .frame(width: Self.size, height: Self.size)
        .animation(.easeOut(duration: 0.15), value: pull.triggered)
        // Centred in the gap above the top card.
        .offset(y: Self.ringOffset(gap: pull.state.offset))
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


    public init(pull: PullModel, threshold: CGFloat = PullModel.threshold, onRefresh: @escaping @MainActor () async -> Void) {
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
                    // The inset does not change while pulling, so this re-renders the modifier only when the top bar or
                    // the calendar changes height. Not only at rest: a pull before the list was ever scrolled (the
                    // first change it reports) had no inset yet and drew the ring at the top of the screen.
                    if abs(geometry.insetTop - insetTop) > 0.5 { insetTop = geometry.insetTop }
                    // Pulled past the top with no finger seen: the hook follows the wrong pan (see heal()).
                    if geometry.overscroll > 2, !finger.isDown { finger.heal?() }
                    pull.track(
                        overscroll: geometry.overscroll,
                        finger: finger.isDown ? finger.translation : nil,
                        interacting: finger.isDown,
                        threshold: threshold,
                        onRefresh: onRefresh
                    )
                }
                #if canImport(UIKit)
                .background(ScrollFingerHook(finger: finger) { isDown in
                    if !isDown {
                        pull.track(overscroll: pull.state.offset, interacting: false, threshold: threshold, onRefresh: onRefresh)
                    }
                })
                #endif
                .overlay(alignment: .top) {
                    GeometryReader { proxy in
                        PullIndicator(pull: pull, threshold: threshold, followsScroll: true)
                            .frame(maxWidth: .infinity)
                            // The gap opens at the list's top inset, right under the top bar (and the calendar).
                            .padding(.top, ListPullGeometry.indicatorTop(insetTop: insetTop, safeAreaTop: proxy.safeAreaInsets.top))
                    }
                    .ignoresSafeArea(edges: .top)
                    .allowsHitTesting(false)
                }
        } else {
            content.refreshable { await onRefresh() }
        }
    }
}

struct ListPullGeometry: Equatable {
    let overscroll: CGFloat
    let insetTop: CGFloat

    /// Where the ring's gap starts, from the top of the screen: the list's top inset, but never inside the safe area
    /// (the status bar and the Dynamic Island), also before the list has reported its inset.
    static func indicatorTop(insetTop: CGFloat, safeAreaTop: CGFloat) -> CGFloat {
        max(insetTop, safeAreaTop)
    }
}

/// Whether a finger is on the list and how far it moved (SwiftUI's scroll phase does not report it for a List).
@MainActor
final class ScrollFinger {
    var isDown = false
    /// The pan's vertical translation while the finger is down (down is positive).
    var translation: CGFloat = 0
    /// Looks again for the list under the finger (set by the hook).
    var heal: (() -> Void)?
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
            for delay in [0.3, 1.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self, self.window != nil else { return }
                    self.coordinator?.attach(from: self)
                }
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
            super.init()
            finger.heal = { [weak self] in self?.heal() }
        }

        private weak var hookView: UIView?
        private var lastHeal = Date.distantPast

        /// Follows the list's pan. Kept while that list is on screen; otherwise (none found yet, or it was rebuilt or
        /// left the window) a new search.
        func attach(from view: UIView) {
            hookView = view
            if let current = scrollView, current.window != nil { return }
            #if DEBUG
            // Checks of heal(): GLUCOMIND_UI_FIXTURES_PULL_UNHOOKED=1 starts without the list's pan, as when the list
            // was not there yet.
            if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_PULL_UNHOOKED"] == "1" { return }
            #endif
            if let found = Self.nearestScrollView(from: view, requireTracking: false) { follow(found) }
        }

        /// The list reports a pull while no finger was seen: the pan followed is not this list's (picked before the
        /// list existed, or the list was rebuilt). The scroll view under the finger is found and followed from now on,
        /// this pull included. Without it the ring only crept along with the bounce and never reached the refresh point
        /// (owner 2026-11-10: "zapełniało się tak wolno", until the tab was left and opened again).
        func heal() {
            guard let hookView, hookView.window != nil else { return }
            if let current = scrollView, current.window != nil, Self.isActive(current.panGestureRecognizer) { return }
            let now = Date()
            guard now.timeIntervalSince(lastHeal) > 0.2 else { return }
            lastHeal = now
            guard let found = Self.nearestScrollView(from: hookView, requireTracking: true), found !== scrollView else { return }
            follow(found)
        }

        private func follow(_ found: UIScrollView) {
            scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(handlePan(_:)))
            scrollView = found
            found.panGestureRecognizer.addTarget(self, action: #selector(handlePan(_:)))
            // Joined in the middle of a pull: it counts from the pan's start.
            if Self.isActive(found.panGestureRecognizer) { handlePan(found.panGestureRecognizer) }
        }

        private static func isActive(_ pan: UIPanGestureRecognizer) -> Bool {
            pan.state == .began || pan.state == .changed
        }

        /// Walks up from `view` and searches each ancestor's subtree, so the closest scroll view wins. Only one on
        /// screen, scrolling up and down, under the middle of the screen the modifier wraps (not a week strip, not a
        /// list of another tab or page); with `requireTracking`, only one a finger is on.
        private static func nearestScrollView(from view: UIView, requireTracking: Bool) -> UIScrollView? {
            guard let window = view.window else { return nil }
            let hookFrame = view.convert(view.bounds, to: window)
            let center = CGPoint(x: hookFrame.midX, y: hookFrame.midY)
            func fits(_ scrollView: UIScrollView) -> Bool {
                guard scrollView.window === window, !scrollView.isHidden, scrollView.alpha > 0.01 else { return false }
                if requireTracking, !scrollView.isTracking { return false }
                let frame = scrollView.convert(scrollView.bounds, to: window)
                return frame.height >= hookFrame.height * 0.4 && frame.contains(center)
            }
            var ancestor = view.superview
            while let current = ancestor {
                var queue = current.subviews
                while !queue.isEmpty {
                    let next = queue.removeFirst()
                    if let scrollView = next as? UIScrollView, fits(scrollView) { return scrollView }
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
            finger.translation = isDown ? pan.translation(in: pan.view).y : 0
            guard isDown != finger.isDown else { return }
            finger.isDown = isDown
            onChange(isDown)
        }
    }
}
#endif
