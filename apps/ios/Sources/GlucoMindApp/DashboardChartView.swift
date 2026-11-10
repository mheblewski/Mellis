import SwiftUI
import GlucoMindCore

// MARK: - Card

/// The chart card: the range picker and the legend bubble in its header, the chart under it. The chart scrolls back in
/// time with a finger (with momentum, history loading well ahead of it); holding a finger still shows a bubble with the
/// time, glucose, IOB, COB and basal of the reading under it, and moving the finger then moves the selection, not the chart.
///
/// Drawn on one Canvas from sorted arrays (binary search for the visible part), so a drag frame costs one redraw and no
/// view diffing. All drag state lives here: the rest of the dashboard never re-renders while the chart moves.
struct ChartCard: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var store: DashboardChartStore
    let now: Date
    /// The dashboard's pull to refresh, switched off while the chart scrolls or selects.
    let pull: PullModel
    /// The forecast line and its cloud on the right of now, or why it is hidden.
    var prediction: ChartPredictionLine? = nil
    /// How far past now the chart reaches while the forecast line is on: "now" is then in the middle of the 3 h range.
    var futureSeconds: TimeInterval = 0

    static let predictionFuture: TimeInterval = 90 * 60

    @State private var scroll = ChartScroll()
    @State private var mode = DragMode.idle
    @State private var pressTask: Task<Void, Never>?
    @State private var fingerX: CGFloat = 0
    @State private var selectedT: TimeInterval?
    /// Animated together when the range changes (a zoom) or a higher reading scrolls in.
    @State private var span: TimeInterval
    @State private var yMax: Double = 210
    /// A small card: one thin line instead of the header, no hours below, so the height goes to the glucose.
    @State private var thin = false
    private static let thinBelow: CGFloat = 176
    private static let fullFrom: CGFloat = 196
    /// The experiment's part of the chart as it moves: see PredictionMotion.
    @State private var motion: PredictionMotion

    init(viewModel: DashboardViewModel, store: DashboardChartStore, now: Date, pull: PullModel, prediction: ChartPredictionLine? = nil, futureSeconds: TimeInterval = 0) {
        self.viewModel = viewModel
        self.store = store
        self.now = now
        self.pull = pull
        self.prediction = prediction
        self.futureSeconds = futureSeconds
        _span = State(initialValue: Self.seconds(viewModel.chartRange))
        // Already drawn as it should be: only a change after this moves.
        _motion = State(initialValue: PredictionMotion(line: Self.drawable(prediction, now: now), futureOn: futureSeconds > 0))
    }

    private static func seconds(_ range: DashboardChartRange) -> TimeInterval {
        Double(range.hours) * 3_600
    }

    /// The right edge when following now: now, or the newest reading if the clock has not caught up with it yet, plus
    /// the room for the prediction while it is on.
    private var liveEnd: TimeInterval {
        newest + Self.room(newest: newest, futureSeconds: futureSeconds, prediction: drawnPrediction)
    }

    private var newest: TimeInterval {
        max(now.timeIntervalSince1970, store.series.readings.last?.t ?? 0)
    }

    /// How far past the newest moment the chart reaches.
    private static func room(newest: TimeInterval, futureSeconds: TimeInterval, prediction: ChartPredictionLine?) -> TimeInterval {
        // The chart ends where the prediction ends, so its band reaches the screen's edge.
        if futureSeconds > 0, let last = prediction?.points.last?.t, last > newest { return last - newest }
        return futureSeconds
    }

    /// The prediction, unless the reading it starts from has gone old.
    private var drawnPrediction: ChartPredictionLine? {
        Self.drawable(prediction, now: now)
    }

    private static func drawable(_ prediction: ChartPredictionLine?, now: Date) -> ChartPredictionLine? {
        guard let prediction else { return nil }
        return prediction.isStale(now: now.timeIntervalSince1970) ? prediction.withoutLine() : prediction
    }

    /// What the chart shows of the prediction. It changes with a new answer, never as the clock runs on.
    private struct PredictionState: Equatable {
        let line: ChartPredictionLine?
        let futureSeconds: TimeInterval
    }

    private var predictionState: PredictionState {
        PredictionState(line: drawnPrediction, futureSeconds: futureSeconds)
    }

    /// The left edge may go back as far as the history allows.
    private var minEnd: TimeInterval {
        now.timeIntervalSince1970 - DashboardChartPrefetch.maxHistory + span
    }

    /// Where the chart comes to rest (the end of a fling), for the y scale and loading.
    private var restingEnd: TimeInterval {
        scroll.restingEnd(liveEnd: liveEnd)
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: scroll.momentum == nil)) { context in
            let end = scroll.end(at: context.date, liveEnd: liveEnd)
            VStack(spacing: 2) {
                header(end: end)
                GeometryReader { geometry in
                    ChartPlot(
                        series: store.series,
                        end: end,
                        span: span,
                        yMax: yMax,
                        size: geometry.size,
                        selectedT: selectedT,
                        // While it follows now the chart's end glides to its new place. Scrolled back it stays where it is.
                        followsNow: scroll.live,
                        endOffsetShown: motion.endOffsetShown,
                        nowT: now.timeIntervalSince1970,
                        motion: motion,
                        futureShown: motion.futureShown,
                        curveShown: motion.curveShown,
                        planShown: motion.planShown,
                        morph: motion.morph,
                        // Only when the chart really lacks what it shows: the dashboard's last 24 h are already in it.
                        showsLoading: store.isLoadingOlder && end - span < (store.historyFrom ?? store.series.readings.first?.t ?? .infinity),
                        thin: thin
                    )
                    .contentShape(Rectangle())
                    .gesture(dragGesture(size: geometry.size))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(accessibilityText)
                    .overlay(alignment: .topTrailing) {
                        if !scroll.live, mode != .selecting {
                            NowButton(action: jumpToNow)
                                .padding(.top, 4)
                                .padding(.trailing, 16)
                                .transition(.opacity.combined(with: .scale(scale: 0.85)))
                        }
                    }
                    .animation(.snappy(duration: 0.25), value: scroll.live)
                }
                .frame(minHeight: 70, maxHeight: .infinity)
            }
        }
        .padding(.vertical, 2)
        // Its own height decides, and the header does not change it: the card takes what the page leaves.
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
            if height < Self.thinBelow, !thin { thin = true } else if height > Self.fullFrom, thin { thin = false }
        }
        .sensoryFeedback(trigger: selectedT) { old, new in
            if old == nil, new != nil { return .impact(weight: .light) }
            if old != nil, new != nil { return .selection }
            return nil
        }
        .onAppear {
            yMax = yTarget
            store.ensureLoaded(visibleStart: restingEnd - span, span: span)
        }
        .onChange(of: viewModel.chartRange) { _, range in
            withAnimation(.smooth(duration: 0.35)) { span = Self.seconds(range) }
        }
        .onChange(of: yTarget) { _, target in
            withAnimation(.smooth(duration: 0.4)) { yMax = target }
        }
        .onChange(of: predictionState) { old, new in
            // All in one write: separate ones in one update can lose the animation.
            var next = motion
            next.change(
                to: new.line,
                futureOn: new.futureSeconds > 0,
                endMovedBy: Self.room(newest: newest, futureSeconds: new.futureSeconds, prediction: new.line)
                    - Self.room(newest: newest, futureSeconds: old.futureSeconds, prediction: old.line)
            )
            withAnimation(PredictionMotion.animation) { motion = next }
        }
        .onChange(of: restingEnd) { _, end in
            store.ensureLoaded(visibleStart: end - span, span: span)
        }
        .onChange(of: span) { _, span in
            store.ensureLoaded(visibleStart: restingEnd - span, span: span)
        }
    }

    /// One thin line, on the screen's margins: the last bolus or when, the range as words, the legend.
    private func header(end: TimeInterval) -> some View {
        HStack(spacing: 8) {
            Group {
                if scroll.live && scroll.momentum == nil {
                    Text(lastBolusText)
                        .monospacedDigit()
                        .accessibilityIdentifier("dashboard.lastBolus")
                } else {
                    Text("\(title(end: end).days), \(title(end: end).times)").monospacedDigit()
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            Spacer(minLength: 4)
            HStack(spacing: 12) {
                ForEach(DashboardChartRange.allCases) { range in
                    Button {
                        viewModel.chartRange = range
                    } label: {
                        Text(range.rawValue)
                            .font(.footnote.weight(range == viewModel.chartRange ? .bold : .medium))
                            .foregroundStyle(range == viewModel.chartRange ? Color.primary : Color.secondary)
                            .frame(minHeight: 24)
                            .contentShape(Rectangle().inset(by: -6))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(range == viewModel.chartRange ? .isSelected : [])
                }
            }
            ChartLegendButton(showsPrediction: futureSeconds > 0, side: 22)
        }
        .frame(height: 24)
        .padding(.horizontal, 16)
    }

    /// The top of the glucose scale: 210 mg/dL while nothing in the window goes past it (the line then fills the chart
    /// instead of an empty band up to 300), else above the highest reading (in steps of 25, so it does not twitch while
    /// scrolling).
    private var yTarget: Double {
        let end = restingEnd
        let readings = store.series.maxValue(from: end - span, to: end) ?? 0
        let line = drawnPrediction?.points.map(\.value).max().map { Int($0) } ?? 0
        let highest = max(readings, line)
        return max(Self.lowestTop, ((Double(highest) + 10) / 25).rounded(.up) * 25)
    }

    static let lowestTop = 210.0

    // MARK: Title

    /// "Bolus 3,5 j · 20:33": the newest bolus of the last 24 h, the same one as on the widget.
    private var lastBolusText: String {
        guard let bolus = viewModel.dashboard.flatMap(DashboardGlance.lastBolus) else { return "Bez bolusa od 24 h" }
        return "Bolus \(DashboardFormat.dose(bolus.units)) j · \(RemoteCommandFormat.time(bolus.at))"
    }

    /// "Ostatnie 3 godziny" over "11:36 – teraz" while following now; after scrolling back the days over the times.
    private func title(end: TimeInterval) -> ChartText.Window {
        if scroll.live && scroll.momentum == nil {
            let days: String
            switch viewModel.chartRange {
            case .threeHours: days = "Ostatnie 3 godziny"
            case .twelveHours: days = "Ostatnie 12 godzin"
            case .day: days = "Ostatnie 24 godziny"
            }
            return ChartText.Window(days: days, times: "\(ChartText.time(end - span)) – teraz")
        }
        return ChartText.window(start: end - span, end: end)
    }

    private var accessibilityText: String {
        let readings = store.series.readings
        guard let last = readings.last else { return "Wykres glukozy: brak odczytów" }
        let title = title(end: scroll.end(at: .now, liveEnd: liveEnd))
        return "Wykres glukozy i insuliny, \(title.days), \(title.times). Ostatni odczyt \(last.value) mg/dL."
    }

    // MARK: Gestures

    /// One drag gesture tells the three apart: a horizontal move scrolls, a vertical one is left to pull to refresh,
    /// a finger held still for a moment selects.
    private func dragGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                fingerX = value.location.x
                let layout = ChartLayout(size: size, end: scroll.end(at: .now, liveEnd: liveEnd), span: span, yMax: yMax, thin: thin, futureShown: futureSeconds > 0 ? 1 : 0)
                switch mode {
                case .idle:
                    pull.touchesChart = true
                    // A touch catches a fling where it is.
                    scroll.stop(at: .now, liveEnd: liveEnd)
                    mode = .pending
                    pressTask?.cancel()
                    pressTask = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(260))
                        guard !Task.isCancelled, mode == .pending else { return }
                        mode = .selecting
                        pull.isSuppressed = true
                        withAnimation(.snappy(duration: 0.18)) {
                            select(x: fingerX, size: size)
                        }
                    }
                case .pending:
                    let moved = value.translation
                    guard hypot(moved.width, moved.height) > 8 else { return }
                    pressTask?.cancel()
                    if abs(moved.width) > abs(moved.height) {
                        mode = .scrolling(baseEnd: layout.end, startX: moved.width)
                        pull.isSuppressed = true
                        scroll.beginDrag(at: layout.end)
                    } else {
                        mode = .ignored
                    }
                case let .scrolling(baseEnd, startX):
                    let secondsPerPoint = span / Double(max(layout.plot.width, 1))
                    let raw = baseEnd - Double(value.translation.width - startX) * secondsPerPoint
                    scroll.drag(to: raw, liveEnd: liveEnd, minEnd: minEnd, secondsPerPoint: secondsPerPoint, width: Double(layout.plot.width))
                case .selecting:
                    select(x: value.location.x, size: size)
                case .ignored:
                    break
                }
            }
            .onEnded { value in
                pressTask?.cancel()
                let layout = ChartLayout(size: size, end: scroll.end(at: .now, liveEnd: liveEnd), span: span, yMax: yMax, thin: thin, futureShown: futureSeconds > 0 ? 1 : 0)
                let secondsPerPoint = span / Double(max(layout.plot.width, 1))
                switch mode {
                case .scrolling:
                    scroll.fling(velocity: -Double(value.velocity.width) * secondsPerPoint, secondsPerPoint: secondsPerPoint, liveEnd: liveEnd, minEnd: minEnd)
                case .selecting:
                    withAnimation(.easeOut(duration: 0.18)) { selectedT = nil }
                default:
                    scroll.fling(velocity: 0, secondsPerPoint: secondsPerPoint, liveEnd: liveEnd, minEnd: minEnd)
                }
                settleWhenDone()
                mode = .idle
                pull.isSuppressed = false
                pull.touchesChart = false
            }
    }

    /// The reading on the finger's vertical line (the nearest one, within a few minutes or a few points).
    private func select(x: CGFloat, size: CGSize) {
        let layout = ChartLayout(size: size, end: scroll.end(at: .now, liveEnd: liveEnd), span: span, yMax: yMax, thin: thin, futureShown: futureSeconds > 0 ? 1 : 0)
        let t = layout.time(atX: min(max(x, layout.plot.minX), layout.plot.maxX))
        let tolerance = max(10 * 60, 24 * span / Double(max(layout.plot.width, 1)))
        guard let index = store.series.nearestReading(to: t, tolerance: tolerance) else { return }
        let reading = store.series.readings[index].t
        if reading != selectedT { selectedT = reading }
    }

    private func jumpToNow() {
        scroll.glide(to: liveEnd, from: scroll.end(at: .now, liveEnd: liveEnd), live: true)
        settleWhenDone()
    }

    /// Ends the glide in the state once its time is up; the frames until then read it off the clock.
    private func settleWhenDone() {
        guard let glide = scroll.momentum else { return }
        let token = scroll.generation
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Int(glide.duration * 1_000) + 16))
            scroll.settle(token)
        }
    }
}

private enum DragMode: Equatable {
    case idle
    /// Down, not moved yet: becomes a selection if it stays still.
    case pending
    case scrolling(baseEnd: TimeInterval, startX: CGFloat)
    case selecting
    /// A vertical move: pull to refresh's.
    case ignored
}

/// The range picker on its own, so a drag frame (which re-renders the title) does not re-render it.
private struct NowButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text("Teraz")
                Image(systemName: "arrow.right.to.line")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(Brand.interactive)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
            .shadow(color: .black.opacity(0.1), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Wróć do teraz")
    }
}

// MARK: - Scrolling

/// Where the chart's right edge is: following now (live), held at a moment, or gliding (a fling, the bounce back
/// from the future, the way back to now). A glide is a closed-form decay read off the frame's clock, so a touch can
/// stop it exactly where it is on screen.
struct ChartScroll {
    struct Glide {
        let from: TimeInterval
        let to: TimeInterval
        let startedAt: TimeInterval
        let duration: TimeInterval
        /// The decay's time constant: smaller stops sooner.
        let tau: TimeInterval
        let endsLive: Bool

        func position(at time: TimeInterval) -> TimeInterval {
            let elapsed = min(max(time - startedAt, 0), duration)
            let progress = (1 - exp(-elapsed / tau)) / (1 - exp(-duration / tau))
            return from + (to - from) * progress
        }
    }

    var live = true
    var end: TimeInterval = 0
    var momentum: Glide?
    /// Changes with every new glide or stop, so an old glide's end does not settle a newer one.
    private(set) var generation = 0

    func end(at date: Date, liveEnd: TimeInterval) -> TimeInterval {
        if let momentum {
            let time = date.timeIntervalSinceReferenceDate
            if time < momentum.startedAt + momentum.duration { return momentum.position(at: time) }
            return momentum.endsLive ? liveEnd : momentum.to
        }
        return live ? liveEnd : end
    }

    func restingEnd(liveEnd: TimeInterval) -> TimeInterval {
        if let momentum { return momentum.endsLive ? liveEnd : momentum.to }
        return live ? liveEnd : end
    }

    mutating func stop(at date: Date, liveEnd: TimeInterval) {
        guard momentum != nil else { return }
        end = end(at: date, liveEnd: liveEnd)
        live = false
        momentum = nil
        generation += 1
    }

    mutating func beginDrag(at current: TimeInterval) {
        end = current
        live = false
        momentum = nil
        generation += 1
    }

    /// Follows the finger; past now it is held back like a scroll view's bounce.
    mutating func drag(to raw: TimeInterval, liveEnd: TimeInterval, minEnd: TimeInterval, secondsPerPoint: Double, width: Double) {
        if raw > liveEnd {
            let overshoot = (raw - liveEnd) / secondsPerPoint
            let banded = (1 - 1 / (overshoot * 0.55 / width + 1)) * width
            end = liveEnd + banded * secondsPerPoint
        } else {
            end = max(raw, minEnd)
        }
    }

    /// After the finger lifts: momentum from its speed (seconds of chart per second), stopping at now; past now it
    /// bounces back and follows now again.
    mutating func fling(velocity: Double, secondsPerPoint: Double, liveEnd: TimeInterval, minEnd: TimeInterval) {
        guard !live else { return }
        let liveSlack = 2 * secondsPerPoint
        if end >= liveEnd - liveSlack {
            glide(to: liveEnd, from: end, live: true, tau: 0.12)
            return
        }
        let tau = 0.38
        let speedPoints = abs(velocity) / secondsPerPoint
        guard speedPoints > 60 else {
            momentum = nil
            return
        }
        var target = end + velocity * tau
        var endsLive = false
        if target >= liveEnd - liveSlack {
            target = liveEnd
            endsLive = true
        }
        target = max(target, minEnd)
        let distancePoints = abs(target - end) / secondsPerPoint
        // Until it would move less than ~8 points a second.
        let duration = min(2.4, max(0.3, tau * log(max(distancePoints / (tau * 8), 1.5))))
        start(Glide(from: end, to: target, startedAt: Date.timeIntervalSinceReferenceDate, duration: duration, tau: tau, endsLive: endsLive))
    }

    mutating func glide(to target: TimeInterval, from current: TimeInterval, live endsLive: Bool, tau: TimeInterval = 0.16) {
        start(Glide(from: current, to: target, startedAt: Date.timeIntervalSinceReferenceDate, duration: tau * 4, tau: tau, endsLive: endsLive))
    }

    private mutating func start(_ glide: Glide) {
        live = false
        end = glide.to
        momentum = glide
        generation += 1
    }

    /// The glide that has ended (the frames read it off the clock until then) becomes the resting state.
    mutating func settle(_ token: Int) {
        guard token == generation, let momentum else { return }
        self.momentum = nil
        live = momentum.endsLive
        end = momentum.to
    }
}

// MARK: - Plot

/// Where things go: the plot inside the y labels (left) and the hour labels (bottom), its time window and glucose
/// scale. Insulin shares the plot as in Nightscout: the basal hangs from the top edge, boluses and SMBs are triangles
/// under the glucose, below the lowest value a CGM reports (40 mg/dL).
struct ChartLayout {
    /// The chart runs from edge to edge of the screen: the labels stand on it, nothing beside it.
    static let leadingGutter: CGFloat = 0
    /// Room right of the newest reading for its ring. With the prediction the chart goes on to the very edge.
    static let ringInset: CGFloat = 14
    static let fullAxisHeight: CGFloat = 16
    /// The lowest value the glucose area shows: the lowest a sensor reports.
    static let lowestValue = 40.0
    static let topPadding: CGFloat = 4

    let plot: CGRect
    let start: TimeInterval
    let end: TimeInterval
    let span: TimeInterval
    let top: Double
    /// The narrow lane under the glucose for the basal and the loop's small doses, in points.
    let laneHeight: CGFloat
    /// A number over each small dose needs the taller lane.
    let showsDoseLabels: Bool
    /// No hours under a small chart: pressing the chart says the time.
    let axisHeight: CGFloat
    let trailingInset: CGFloat
    private let pointsPerValue: CGFloat

    /// `futureShown` 0 leaves the room for the ring, 1 (the experiment on) goes to the very edge, between them while it glides.
    init(size: CGSize, end: TimeInterval, span: TimeInterval, yMax: Double, thin: Bool = false, futureShown: Double = 0) {
        trailingInset = Self.ringInset * CGFloat(1 - min(max(futureShown, 0), 1))
        axisHeight = thin ? 0 : Self.fullAxisHeight
        laneHeight = thin ? 18 : 34
        showsDoseLabels = !thin
        plot = CGRect(
            x: Self.leadingGutter,
            y: 0,
            width: max(1, size.width - Self.leadingGutter - trailingInset),
            height: max(1, size.height - axisHeight)
        )
        self.end = end
        self.span = span
        start = end - span
        top = yMax
        pointsPerValue = max(0.01, plot.height - laneHeight - Self.topPadding - 2) / CGFloat(yMax - Self.lowestValue)
    }

    /// Where the lane starts; the glucose stays above it.
    var laneTop: CGFloat { plot.maxY - laneHeight }
    /// The basal band's full height: most of the lane, which the glucose never uses, so the glucose keeps its height.
    var basalHeight: CGFloat { laneHeight - (showsDoseLabels ? 12 : 6) }
    /// Where the marks may stand, up to the top of the scale.
    var ceiling: CGFloat { plot.minY + 2 }
    /// The whole width, the part beside the newest reading too.
    var fullWidth: CGFloat { plot.width + trailingInset }

    func x(_ t: TimeInterval) -> CGFloat {
        plot.minX + CGFloat((t - start) / span) * plot.width
    }

    func y(_ value: Double) -> CGFloat {
        Self.topPadding + CGFloat(top - value) * pointsPerValue
    }

    func time(atX x: CGFloat) -> TimeInterval {
        start + Double((x - plot.minX) / plot.width) * span
    }
}

/// The prediction's part of the chart as it moves. The shown values are what SwiftUI animates; the ones next to them
/// stay put during the glide, so ChartPlot can tell from the two how far along it is.
struct PredictionMotion {
    static let animation = Animation.smooth(duration: 0.55)

    /// The line and fan to draw, kept while they fade out. The plan and the hidden reason, likewise.
    private(set) var curve: ChartPredictionLine?
    private(set) var plan: ChartPredictionLine?
    /// The line this one is changing from, and which change is the newest one.
    private(set) var previousCurve: ChartPredictionLine?
    private(set) var morphTarget = 0.0
    private(set) var morph = 0.0
    private(set) var curveShown: Double
    private(set) var planShown: Double
    /// The "teraz" rule and the chart reaching the edge.
    private(set) var futureShown: Double
    /// The chart's real end has jumped; these two differ by what is left of the jump, so what is drawn glides after it.
    private(set) var endOffset = 0.0
    private(set) var endOffsetShown = 0.0

    init(line: ChartPredictionLine?, futureOn: Bool) {
        let hasCurve = line?.points.isEmpty == false
        curve = hasCurve ? line : nil
        plan = line
        curveShown = hasCurve ? 1 : 0
        planShown = line == nil ? 0 : 1
        futureShown = futureOn ? 1 : 0
    }

    /// Set inside an animation. A first line unrolls from now, a new one moves from the old one, a line gone fades away.
    /// The same for the plan.
    mutating func change(to line: ChartPredictionLine?, futureOn: Bool, endMovedBy: TimeInterval) {
        let hasCurve = line?.points.isEmpty == false
        if let line, hasCurve {
            let hadCurve = curve != nil && curveShown > 0
            previousCurve = hadCurve ? curve : nil
            curve = line
            if hadCurve { morphTarget += 1 }
        }
        if let line { plan = line }
        curveShown = hasCurve ? 1 : 0
        planShown = line == nil ? 0 : 1
        morph = morphTarget
        futureShown = futureOn ? 1 : 0
        endOffset += endMovedBy
        endOffsetShown = endOffset
    }

    /// The line at this moment of the change from the previous one.
    func curve(atMorph shown: Double) -> ChartPredictionLine? {
        guard let curve, let previousCurve else { return curve }
        return curve.morphed(from: previousCurve, progress: 1 - min(max(morphTarget - shown, 0), 1))
    }
}

/// The chart itself: one Canvas and the selection bubble. Animatable, so a zoom (range change), a new y scale, a new
/// height (a row coming or going under the chart) and everything about the prediction glide instead of jumping.
private struct ChartPlot: View, Animatable {
    let series: DashboardChartSeries
    let end: TimeInterval
    var span: TimeInterval
    var yMax: Double
    var size: CGSize
    let selectedT: TimeInterval?
    let followsNow: Bool
    var endOffsetShown: TimeInterval
    let nowT: TimeInterval
    let motion: PredictionMotion
    var futureShown: Double
    var curveShown: Double
    var planShown: Double
    var morph: Double
    let showsLoading: Bool
    var thin = false

    var animatableData: AnimatablePair<AnimatablePair<AnimatablePair<Double, Double>, AnimatablePair<CGFloat, Double>>, AnimatablePair<AnimatablePair<Double, Double>, AnimatablePair<Double, Double>>> {
        get {
            AnimatablePair(
                AnimatablePair(AnimatablePair(span, yMax), AnimatablePair(size.height, endOffsetShown)),
                AnimatablePair(AnimatablePair(futureShown, curveShown), AnimatablePair(planShown, morph))
            )
        }
        set {
            span = newValue.first.first.first
            yMax = newValue.first.first.second
            size.height = newValue.first.second.first
            endOffsetShown = newValue.first.second.second
            futureShown = newValue.second.first.first
            curveShown = newValue.second.first.second
            planShown = newValue.second.second.first
            morph = newValue.second.second.second
        }
    }

    var body: some View {
        let shownEnd = followsNow ? end + endOffsetShown - motion.endOffset : end
        let layout = ChartLayout(size: size, end: shownEnd, span: span, yMax: yMax, thin: thin, futureShown: futureShown)
        Canvas { context, _ in
            ChartRenderer(
                layout: layout, series: series, selectedT: selectedT, nowT: nowT,
                futureShown: futureShown,
                curve: motion.curve(atMorph: morph), curveShown: curveShown,
                plan: motion.plan, planShown: planShown
            ).draw(in: &context)
        }
        .frame(height: size.height, alignment: .top)
        .overlay(alignment: .topLeading) {
            if let selectedT, let index = series.nearestReading(to: selectedT, tolerance: 1) {
                let reading = series.readings[index]
                BubblePlacement(
                    pointX: layout.x(reading.t),
                    pointY: layout.y(Double(reading.value)),
                    top: layout.plot.minY + 2
                ) {
                    SelectionBubble(reading: reading, loop: series.loopValues(at: reading.t), basal: series.basalRate(at: reading.t), basalPlan: series.basalPlanRate(at: reading.t))
                        .fixedSize()
                }
                .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .bottom)))
                .allowsHitTesting(false)
            }
        }
        .overlay(alignment: .leading) {
            if showsLoading {
                ProgressView()
                    .controlSize(.small)
                    .padding(8)
                    .background(.regularMaterial, in: Circle())
                    .offset(x: ChartLayout.leadingGutter + 6, y: -layout.axisHeight / 2)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: showsLoading)
    }
}

/// Puts the bubble above the plot at the reading's time, as wide as its content, and keeps it inside the chart; beside
/// the point when the point would be under it.
private struct BubblePlacement: Layout {
    let pointX: CGFloat
    let pointY: CGFloat
    let top: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let bubble = subviews.first else { return }
        let size = bubble.sizeThatFits(.unspecified)
        var left = pointX - size.width / 2
        if pointY < top + size.height + 10 {
            left = pointX + 14 + size.width <= bounds.width ? pointX + 14 : pointX - 14 - size.width
        }
        left = min(max(left, 0), max(0, bounds.width - size.width))
        bubble.place(at: CGPoint(x: bounds.minX + left, y: bounds.minY + top), proposal: ProposedViewSize(size))
    }
}

/// Time, glucose (in its colour), IOB, COB and the basal running at the selected reading.
private struct SelectionBubble: View {
    let reading: DashboardChartSeries.Reading
    let loop: DashboardChartSeries.Loop?
    let basal: Double?
    /// The planned basal then: the bubble says "0,1 z 0,25 j/h".
    let basalPlan: Double?

    var body: some View {
        let level = DashboardThresholds.glucose(reading.value)
        VStack(alignment: .leading, spacing: 1) {
            Text(ChartText.moment(reading.t))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text("\(reading.value)")
                    .font(.system(size: 22, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(DashboardPalette.glucose(level))
                Text("mg/dL")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            // The dashboard chips' icons instead of names, so the bubble stays narrow.
            HStack(spacing: 10) {
                metric(Image(systemName: "drop.fill").font(.caption2.weight(.semibold)).foregroundStyle(DashboardPalette.insulin), name: "IOB", value: loop?.iob.map { "\(DashboardFormat.iob($0)) j" })
                metric(Image(systemName: "fork.knife").font(.caption2.weight(.semibold)).foregroundStyle(.orange), name: "COB", value: loop?.cob.map { "\(Int($0.rounded())) g" })
            }
            // The basal on its own line: with the plan ("0,5 z 0,25 j/h") one row made the bubble too wide.
            metric(SquareWave().stroke(ChartRenderer.basalBlue, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)).frame(width: 11, height: 9), name: "Baza", value: basalText, detail: basalPlanText)
                .padding(.top, 1)
        }
        .lineLimit(1)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
        .shadow(color: .black.opacity(0.14), radius: 10, y: 4)
    }

    /// "0,5 j/h", then the plan " z 0,25" lighter, as on the basal chip above the chart.
    private var basalText: String? {
        basal.map { "\(DashboardFormat.dose($0)) j/h" }
    }

    private var basalPlanText: String? {
        guard basal != nil, let basalPlan else { return nil }
        return " z \(DashboardFormat.dose(basalPlan))"
    }

    /// `detail` follows the value a little smaller and lighter: the plan beside the basal given.
    private func metric(_ icon: some View, name: String, value: String?, detail: String? = nil) -> some View {
        HStack(spacing: 3) {
            icon
            (Text(value ?? "—").font(.caption.weight(.semibold))
                + Text(detail ?? "").font(.caption2.weight(.medium)).foregroundColor(.secondary))
                .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) \(value ?? "brak")\(detail ?? "")")
    }
}

/// The basal's mark in the bubble: a square wave, as the basal's steps on the chart (SF Symbols has none).
struct SquareWave: Shape {
    func path(in rect: CGRect) -> Path {
        let x = { (fraction: CGFloat) in rect.minX + rect.width * fraction }
        let y = { (fraction: CGFloat) in rect.minY + rect.height * fraction }
        var path = Path()
        path.move(to: CGPoint(x: x(0), y: y(0.5)))
        path.addLine(to: CGPoint(x: x(0.28), y: y(0.5)))
        path.addLine(to: CGPoint(x: x(0.28), y: y(1)))
        path.addLine(to: CGPoint(x: x(0.5), y: y(1)))
        path.addLine(to: CGPoint(x: x(0.5), y: y(0)))
        path.addLine(to: CGPoint(x: x(0.72), y: y(0)))
        path.addLine(to: CGPoint(x: x(0.72), y: y(0.5)))
        path.addLine(to: CGPoint(x: x(1), y: y(0.5)))
        return path
    }
}

// MARK: - Drawing

/// Draws the visible window: range band, thresholds, hour grid, basal, the glucose line and dots, insulin marks, the
/// selection and the axis labels. Everything outside the window is skipped by binary search.
private struct ChartRenderer {
    let layout: ChartLayout
    let series: DashboardChartSeries
    let selectedT: TimeInterval?
    var nowT: TimeInterval = 0
    /// Each part of the prediction with how much of it shows, 0 to 1: see PredictionMotion.
    var futureShown = 0.0
    var curve: ChartPredictionLine? = nil
    var curveShown = 0.0
    var plan: ChartPredictionLine? = nil
    var planShown = 0.0

    private static let bolusBlue = DashboardPalette.insulin
    /// Lighter than the bolus blue, so the band reads on black too.
    static let basalBlue = DashboardPalette.basal
    private static let smbPurple = Color(red: 0.557, green: 0.486, blue: 0.941)
    private static let smbLabel = DashboardPalette.smbLabel
    /// A gap longer than this breaks the line (a sensor change, a lost signal).
    private static let lineGap: TimeInterval = 16 * 60

    private var hours: Double { layout.span / 3_600 }

    func draw(in context: inout GraphicsContext) {
        let plot = layout.plot
        var plotContext = context
        // The trailing inset belongs to the plot too: the newest reading's ring at the right edge is not cut.
        plotContext.clip(to: Path(CGRect(x: plot.minX, y: plot.minY, width: plot.width + layout.trailingInset, height: plot.height)))

        drawBackground(&plotContext)
        drawBasal(&plotContext)
        drawPrediction(&plotContext)
        drawGlucose(&plotContext)
        drawInsulin(&plotContext)
        drawDoseMarks(&plotContext)
        drawDayChips(&plotContext)
        drawSelection(&plotContext)

        if layout.axisHeight > 0 { drawTimeAxis(&context) }
        drawValueAxis(&context)
    }

    private func drawBackground(_ context: inout GraphicsContext) {
        let plot = layout.plot

        var grid = Path()
        var midnights = Path()
        for tick in hourTicks() {
            let x = layout.x(tick.t)
            if tick.hour == 0 {
                // Where a day starts: a firmer line from under the day's chip to the lane.
                midnights.move(to: CGPoint(x: x, y: plot.minY + Self.dayChipHeight + 3))
                midnights.addLine(to: CGPoint(x: x, y: layout.laneTop))
            } else {
                grid.move(to: CGPoint(x: x, y: plot.minY))
                grid.addLine(to: CGPoint(x: x, y: layout.laneTop))
            }
        }
        context.stroke(grid, with: .color(Color.secondary.opacity(0.2)), lineWidth: 0.5)
        context.stroke(midnights, with: .color(Color.primary.opacity(0.28)), lineWidth: 1)

        // The range 70–180 as a very faint green field, so a line leaving it shows without reading the axis.
        let rangeTop = layout.y(min(180, layout.top)), rangeBottom = layout.y(70)
        if rangeBottom > rangeTop {
            context.fill(Path(CGRect(x: plot.minX, y: rangeTop, width: layout.fullWidth, height: rangeBottom - rangeTop)),
                         with: .color(DashboardPalette.green.opacity(0.10)))
        }

        let dash = StrokeStyle(lineWidth: 1, dash: [3, 3])
        // The 250 line only when the scale reaches it.
        for (value, color) in [(250.0, DashboardPalette.red.opacity(0.45)), (180.0, DashboardPalette.yellow.opacity(0.75)), (70.0, DashboardPalette.red.opacity(0.85))] where value <= layout.top {
            var rule = Path()
            rule.move(to: CGPoint(x: plot.minX, y: layout.y(value)))
            rule.addLine(to: CGPoint(x: plot.minX + layout.fullWidth, y: layout.y(value)))
            context.stroke(rule, with: .color(color), style: dash)
        }
    }

    /// The basal as a band in the lane, standing on the bottom edge, and the planned (profile) basal as a dashed step
    /// line over it: a temp basal above the plan stands out of the line, a lower one or none leaves room under it.
    /// The scale follows the loaded plan's highest step (steady while scrolling), so a small child's 0.2 U/h is as tall as an adult's 1 U/h: the plan stands at
    /// `planShare` of the band's height. Without a plan (older server) the scale follows the loaded delivered basal and no
    /// basal at all is a dashed line on the bottom, so it does not read as no data.
    private func drawBasal(_ context: inout GraphicsContext) {
        let base = layout.plot.maxY - 1
        let from = layout.start - 60, to = layout.end + 60
        let runs = Self.runs(series.basal, from: from, to: to)
        let plan = Self.runs(series.basalPlan, from: from, to: to)
        // The scale comes from everything loaded, not just the window: a plan step sliding in or out of view while
        // scrolling changed the scale, and a temp basal then hit the top and lost its steps.
        let planMax = series.basalPlan.map(\.rate).max() ?? 0
        let reference = planMax > 0
            ? planMax / Self.planShare
            : max(series.basal.map(\.rate).max() ?? 0, Self.lowestReference)
        let tallest = layout.basalHeight
        let height = { (rate: Double) in CGFloat(min(rate / reference, 1)) * tallest }

        // The delivered basal: a light fill under a solid step edge, so it reads on black and on white alike; a
        // zero rate is the edge along the bottom. The edge breaks only where the basal is unknown.
        var band = Path()
        var edge = Path()
        var none = Path()
        var edgeEnd: (t: TimeInterval, y: CGFloat)?
        for run in runs {
            let x0 = layout.x(max(run.start, from)), x1 = layout.x(min(run.end, to))
            let y = run.rate > 0 ? base - max(1.6, height(run.rate)) : base
            if run.rate > 0 { band.addRect(CGRect(x: x0, y: y, width: x1 - x0, height: base - y)) }
            if run.rate <= 0, plan.isEmpty {
                none.move(to: CGPoint(x: x0, y: base - 0.75))
                none.addLine(to: CGPoint(x: x1, y: base - 0.75))
                edgeEnd = nil
                continue
            }
            if let last = edgeEnd, abs(last.t - run.start) < 1 {
                edge.addLine(to: CGPoint(x: x0, y: y))
            } else {
                edge.move(to: CGPoint(x: x0, y: base))
                edge.addLine(to: CGPoint(x: x0, y: y))
            }
            edge.addLine(to: CGPoint(x: x1, y: y))
            edgeEnd = (run.end, y)
        }
        context.fill(band, with: .color(Self.basalBlue.opacity(0.22)))
        context.stroke(edge, with: .color(Self.basalBlue), style: StrokeStyle(lineWidth: 1.5, lineJoin: .miter))
        context.stroke(none, with: .color(Self.basalBlue), style: StrokeStyle(lineWidth: 1.2, dash: [2, 3]))

        // The plan: a neutral dashed step line, so it does not read as insulin given.
        var line = Path()
        var lastEnd: TimeInterval?
        for run in plan {
            let y = base - max(1.6, height(run.rate))
            let x0 = layout.x(max(run.start, from)), x1 = layout.x(min(run.end, to))
            if let lastEnd, abs(lastEnd - run.start) < 1 { line.addLine(to: CGPoint(x: x0, y: y)) } else { line.move(to: CGPoint(x: x0, y: y)) }
            line.addLine(to: CGPoint(x: x1, y: y))
            lastEnd = run.end
        }
        context.stroke(line, with: .color(Color.primary.opacity(0.55)), style: StrokeStyle(lineWidth: 1.2, lineJoin: .round, dash: [3, 3]))
    }

    /// Where the planned basal stands in the band: room above it for a temp basal up to 2.5 times the plan.
    private static let planShare = 0.4
    /// Without a plan, a basal under this (U/h) does not fill the band.
    private static let lowestReference = 0.2

    private static func runs(_ all: [DashboardChartSeries.Basal], from: TimeInterval, to: TimeInterval) -> ArraySlice<DashboardChartSeries.Basal> {
        let first = DashboardChartSeries.lowerBound(all, from - 86_400, key: { $0.start })
        var last = first
        while last < all.count, all[last].start < to { last += 1 }
        return all[first..<last].filter { $0.end > from }[...]
    }

    private func drawGlucose(_ context: inout GraphicsContext) {
        let range = series.readingIndices(from: layout.start, to: layout.end)
        guard !range.isEmpty else { return }
        let readings = series.readings

        // The line: a monotone curve through each run of readings without a gap.
        var line = Path()
        var run: [CGPoint] = []
        run.reserveCapacity(range.count)
        var previous: TimeInterval?
        for index in range {
            let reading = readings[index]
            if let previous, reading.t - previous > Self.lineGap {
                Self.addMonotone(&line, run)
                run.removeAll(keepingCapacity: true)
            }
            run.append(CGPoint(x: layout.x(reading.t), y: layout.y(Double(reading.value))))
            previous = reading.t
        }
        Self.addMonotone(&line, run)
        // One line in the colour of where it runs: hard steps at 180 and 70, always where the rules are.
        let y180 = layout.y(180), y70 = layout.y(70), height = max(1, layout.plot.height)
        let high = min(1, max(0, y180 / height)), low = min(1, max(high, y70 / height))
        let gradient = Gradient(stops: [
            .init(color: DashboardPalette.glucose(.warning), location: 0),
            .init(color: DashboardPalette.glucose(.warning), location: high),
            .init(color: DashboardPalette.glucose(.normal), location: high),
            .init(color: DashboardPalette.glucose(.normal), location: low),
            .init(color: DashboardPalette.glucose(.alarm), location: low),
            .init(color: DashboardPalette.glucose(.alarm), location: 1),
        ])
        context.stroke(
            line,
            with: .linearGradient(gradient, startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: height)),
            style: StrokeStyle(lineWidth: hours <= 4.5 ? 2.6 : 2.1, lineCap: .round, lineJoin: .round)
        )

        // The newest reading in a ring, the light of the screen showing through it.
        if let last = readings.last, last.t >= layout.start, last.t <= layout.end + 60 {
            let center = CGPoint(x: layout.x(last.t), y: layout.y(Double(last.value)))
            let ring = Path(ellipseIn: CGRect(x: center.x - 4.6, y: center.y - 4.6, width: 9.2, height: 9.2))
            Self.cutOut(ring, filled: true, in: &context)
            context.stroke(ring, with: .color(DashboardPalette.glucose(DashboardThresholds.glucose(last.value))), lineWidth: 2.5)
        }
    }

    /// Takes the chart away around a mark, so the screen's own colour shows there: there is no card to paint with.
    private static func cutOut(_ path: Path, filled: Bool = false, lineWidth: CGFloat = 3, in context: inout GraphicsContext) {
        var eraser = context
        eraser.blendMode = .destinationOut
        if filled {
            eraser.fill(path, with: .color(.black))
        } else {
            eraser.stroke(path, with: .color(.black), lineWidth: lineWidth)
        }
    }

    /// "Prognoza glukozy": a soft band and a dashed grey line from the newest reading, with a thin rule at now. Grey on
    /// purpose: it says how things usually go, it is not a reading. When hidden, a short reason in the same place.
    private func drawPrediction(_ context: inout GraphicsContext) {
        guard futureShown > 0 else { return }
        let plot = layout.plot
        let nowX = layout.x(nowT)
        if nowX >= plot.minX, nowX <= plot.maxX {
            var ruleContext = context
            ruleContext.opacity = min(futureShown, 1)
            var rule = Path()
            rule.move(to: CGPoint(x: nowX, y: plot.minY))
            rule.addLine(to: CGPoint(x: nowX, y: plot.maxY))
            ruleContext.stroke(rule, with: .color(Color.primary.opacity(0.35)), lineWidth: 1)
            let label = ruleContext.resolve(Text(PredictionExperimentText.nowLabel).font(.system(size: 9.5, weight: .semibold)).foregroundColor(.secondary))
            ruleContext.draw(label, at: CGPoint(x: nowX + 4, y: layout.y(180) + 3), anchor: .topLeading)
        }
        if let plan, planShown > 0 {
            var planContext = context
            planContext.opacity = min(planShown, 1)
            drawPlan(plan, nowX: nowX, nowT: nowT, in: &planContext)
            if let reason = plan.hiddenText {
                let room = plot.maxX - max(nowX, plot.minX) - 8
                if room > 40 {
                    let text = planContext.resolve(Text(reason).font(.system(size: 10, weight: .medium)).foregroundColor(.secondary))
                    let size = text.measure(in: CGSize(width: room - 10, height: 44))
                    // On its own background, so a grid line behind it does not cut the words.
                    let chip = CGRect(x: max(nowX, plot.minX) + 6, y: layout.y(130), width: size.width + 10, height: size.height + 6)
                    planContext.fill(Path(roundedRect: chip, cornerRadius: 5), with: .color(DashboardPalette.cardBackground.opacity(0.92)))
                    planContext.draw(text, in: chip.insetBy(dx: 5, dy: 3))
                }
            }
        }
        guard let curve, curveShown > 0, !curve.points.isEmpty else { return }
        let origin = CGPoint(x: layout.x(curve.originT), y: layout.y(curve.originValue))
        // It unrolls from the newest reading to the right as it comes in.
        let shown = min(max(curveShown, 0), 1)
        let right = plot.minX + layout.fullWidth
        var curveContext = context
        curveContext.opacity = shown
        curveContext.clip(to: Path(CGRect(x: origin.x - 2, y: plot.minY, width: max(right - origin.x + 2, 0) * shown, height: plot.height)))
        var fan = Path()
        fan.move(to: origin)
        for point in curve.points { fan.addLine(to: CGPoint(x: layout.x(point.t), y: layout.y(point.high))) }
        for point in curve.points.reversed() { fan.addLine(to: CGPoint(x: layout.x(point.t), y: layout.y(point.low))) }
        fan.closeSubpath()
        curveContext.fill(fan, with: .color(Color.secondary.opacity(0.18)))
        var line = Path()
        Self.addMonotone(&line, [origin] + curve.points.map { CGPoint(x: layout.x($0.t), y: layout.y($0.value)) })
        curveContext.stroke(line, with: .color(Color.secondary.opacity(0.9)), style: StrokeStyle(lineWidth: 1.6, dash: [4, 3]))
        if let last = curve.points.last {
            let label = curveContext.resolve(Text(PredictionExperimentText.lineLabel).font(.system(size: 9.5, weight: .medium)).foregroundColor(.secondary))
            // Tied to the line's end: it moves away with the line when the chart is scrolled back.
            curveContext.draw(label, at: CGPoint(x: layout.x(last.t) - 4, y: layout.y(last.value) + 3), anchor: .topTrailing)
        }
    }

    /// What is planned ahead: a soft area for a possible late rise and thin lines with a label for what is planned. Only
    /// what fits on the chart; no values: a plan can change, and the line does not include it.
    private func drawPlan(_ prediction: ChartPredictionLine, nowX: CGFloat, nowT: TimeInterval, in context: inout GraphicsContext) {
        let plot = layout.plot
        let tint = Color.orange
        let top = layout.ceiling
        // Below 70 a possible late rise is no news worth the space (texts review, 2026-11-09).
        let belowLow = (series.readings.last?.value ?? 70) < 70
        for zone in prediction.zones where !belowLow && zone.to > nowT && zone.from < layout.end {
            let left = max(layout.x(max(zone.from, nowT)), plot.minX)
            let right = min(layout.x(zone.to), plot.maxX)
            guard right > left else { continue }
            context.fill(Path(CGRect(x: left, y: plot.minY, width: right - left, height: plot.height)), with: .color(tint.opacity(0.09)))
            // One line just above 70, moved left when the zone is cut by the chart's edge.
            let text = context.resolve(Text(PredictionExperimentText.lateRise).font(.system(size: 9.5, weight: .medium)).foregroundColor(tint))
            let size = text.measure(in: CGSize(width: 150, height: 14))
            let chip = CGRect(x: min(left + 2, plot.maxX - size.width - 8), y: layout.y(70) - 18, width: size.width + 8, height: 15)
            context.fill(Path(roundedRect: chip, cornerRadius: 4), with: .color(DashboardPalette.cardBackground.opacity(0.92)))
            context.draw(text, at: CGPoint(x: chip.midX, y: chip.midY), anchor: .center)
        }
        var row = 0
        for marker in prediction.markers where marker.t >= layout.start && marker.t <= layout.end {
            let x = layout.x(marker.t)
            let color = marker.settled ? Color.secondary : (marker.isFood ? Color.orange : Brand.interactive)
            var line = Path()
            line.move(to: CGPoint(x: x, y: top))
            line.addLine(to: CGPoint(x: x, y: plot.maxY))
            context.stroke(line, with: .color(color.opacity(0.6)), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
            let text = context.resolve(Text(marker.label).font(.system(size: 9.5, weight: .semibold)).foregroundColor(color))
            let size = text.measure(in: CGSize(width: 150, height: 14))
            let width = size.width + 8
            // Centred on its own dashed line (moved in only at the chart's edges), with that line's colour as a frame, on
            // an opaque background that covers the "teraz" rule, so it does not read as the label of the solid line beside it.
            let left = min(max(x - width / 2, plot.minX), plot.maxX - width)
            let chip = CGRect(x: left, y: top + CGFloat(row) * 17, width: width, height: 15)
            let shape = Path(roundedRect: chip, cornerRadius: 4)
            context.fill(shape, with: .color(DashboardPalette.cardBackground))
            context.stroke(shape, with: .color(color.opacity(0.6)), lineWidth: 1)
            context.draw(text, at: CGPoint(x: chip.midX, y: chip.midY), anchor: .center)
            row = (row + 1) % 3
        }
    }

    /// SMBs: small purple triangles along the bottom, the dose above each on short ranges, sums per hour (two on 24 h)
    /// below on longer ones. Boluses and carbs are drawn with the glucose line (drawDoseMarks).
    private func drawInsulin(_ context: inout GraphicsContext) {
        let baseline = layout.plot.maxY - 9
        let perDoseLabels = hours <= 4.5 && layout.showsDoseLabels
        let smbSize: CGFloat = perDoseLabels ? 6 : 5

        var smbTriangles = Path()
        let from = layout.start - 3_600, to = layout.end + 3_600
        for index in series.doseIndices(series.smbs, from: from, to: to) {
            let smb = series.smbs[index]
            let x = layout.x(smb.t)
            smbTriangles.addPath(Self.triangle(tipX: x, tipY: baseline, width: smbSize, height: smbSize * 0.85))
            if perDoseLabels {
                Self.drawHaloed(DashboardFormat.dose(smb.units), color: Self.smbLabel, at: CGPoint(x: x, y: baseline - smbSize * 0.85 - 1), in: &context)
            }
        }
        context.fill(smbTriangles, with: .color(Self.smbPurple))
        if !perDoseLabels, layout.showsDoseLabels {
            // A sum whose hour is in view, kept whole inside the plot at its edges.
            let visible = layout.plot.minX...(layout.plot.maxX + layout.trailingInset)
            for sum in series.smbSums(from: from, to: to, bucket: hours > 15 ? 7_200 : 3_600) where visible.contains(layout.x(sum.t)) {
                let text = context.resolve(Text(DashboardFormat.dose(sum.units)).font(.system(size: 10, weight: .bold)).foregroundColor(Self.smbLabel))
                let half = text.measure(in: CGSize(width: 100, height: 30)).width / 2
                let x = min(max(layout.x(sum.t), visible.lowerBound + half + 1), visible.upperBound - half - 1)
                Self.drawHaloed(DashboardFormat.dose(sum.units), color: Self.smbLabel, at: CGPoint(x: x, y: baseline - 7), in: &context)
            }
        }

    }

    /// A small label over the basal band: a ring of the page's colour around the letters keeps it readable on the band
    /// and the plan line.
    private static func drawHaloed(_ string: String, color: Color, at point: CGPoint, in context: inout GraphicsContext) {
        let font = Font.system(size: 10, weight: .bold)
        let halo = context.resolve(Text(string).font(font).foregroundColor(DashboardPalette.pageBackground))
        for (dx, dy) in [(-1.2, 0.0), (1.2, 0.0), (0.0, -1.2), (0.0, 1.2), (-0.9, -0.9), (0.9, -0.9), (-0.9, 0.9), (0.9, 0.9)] {
            context.draw(halo, at: CGPoint(x: point.x + dx, y: point.y + dy), anchor: .bottom)
        }
        context.draw(context.resolve(Text(string).font(font).foregroundColor(color)), at: point, anchor: .bottom)
    }

    /// The carbs' orange, as the COB chip's fork.
    private static let carbOrange = Color.orange

    /// How far a bolus triangle or a carb dot stands off the glucose line.
    private static let markGap: CGFloat = 6

    /// The glucose line's y at `t` (the nearest reading within 20 min), else the bottom of the glucose range.
    private func lineY(at t: TimeInterval) -> CGFloat {
        layout.y(series.nearestReading(to: t, tolerance: 20 * 60).map { Double(series.readings[$0].value) } ?? 40)
    }

    /// Doses or carbs whose marks would touch at this range: one mark with their sum at their weighted time.
    private func merged(_ items: [DashboardChartSeries.Dose], minimumGap: Double) -> [DashboardChartSeries.Dose] {
        let range = Array(series.doseIndices(items, from: layout.start - 3_600, to: layout.end + 3_600))
        return DashboardChartSeries.clusters(at: range.map { Double(layout.x(items[$0].t)) }, minimumGap: minimumGap).map { group in
            let entries = group.map { items[range[$0]] }
            let total = entries.reduce(0) { $0 + $1.units }
            let t = total > 0 ? entries.reduce(0) { $0 + $1.t * $1.units } / total : entries[0].t
            return DashboardChartSeries.Dose(t: t, units: total)
        }
    }

    /// A bolus or carb mark placed next to the glucose line, with the rectangle its label may not cover.
    private struct DoseMark {
        let x: CGFloat
        /// The mark's bounds; `away` is the direction off the line (-1 up, 1 down).
        let bounds: CGRect
        let away: CGFloat
        let label: GraphicsContext.ResolvedText
        let size: CGSize
        let isBolus: Bool
    }

    /// Boluses as blue triangles above the glucose line pointing at it, carbs as orange dots under it (each flips side
    /// where the basal band or the SMB row leaves no room); marks too close to tell apart are one mark with their sum.
    /// Each label then takes the free spot nearest its mark: off the line first, a row further, beside the mark, never
    /// over another mark or label and as little as possible over the glucose dots. A label is drawn only while its mark
    /// is in view, so nothing stays pinned at the edges while the chart scrolls.
    private func drawDoseMarks(_ context: inout GraphicsContext) {
        let short = hours <= 4.5
        let gap = short ? 14.0 : 26.0
        let ceiling = layout.ceiling
        let floor = layout.laneTop
        let font = Font.system(size: short ? 11 : 10, weight: .bold)
        var marks: [DoseMark] = []

        var triangles = Path()
        for bolus in merged(series.boluses, minimumGap: gap) {
            let x = layout.x(bolus.t), line = lineY(at: bolus.t)
            // The triangle must fit under the basal band; its label may reach into the band.
            let up = line - Self.markGap - 8 >= ceiling
            let tip = up ? line - Self.markGap : line + Self.markGap
            let triangle = Self.triangle(tipX: x, tipY: tip, width: 9, height: up ? 8 : -8)
            Self.cutOut(triangle, in: &context)
            triangles.addPath(triangle)
            let label = context.resolve(Text("\(DashboardFormat.dose(bolus.units)) j").font(font).foregroundColor(Self.bolusBlue))
            marks.append(DoseMark(x: x, bounds: triangle.boundingRect, away: up ? -1 : 1, label: label,
                                  size: label.measure(in: CGSize(width: 200, height: 40)), isBolus: true))
        }
        context.fill(triangles, with: .color(Self.bolusBlue))

        let radius: CGFloat = short ? 4.5 : 3.5
        for carb in merged(series.carbs, minimumGap: gap) {
            let x = layout.x(carb.t), line = lineY(at: carb.t)
            let down = line + radius + 14 <= floor
            // On the line itself, where the carbs went in.
            var y = line
            // Never over a bolus given at the same time (a steep line brings them together): past it, off the line.
            for bolus in marks where bolus.bounds.insetBy(dx: -radius - 2, dy: -radius - 2).contains(CGPoint(x: x, y: y)) {
                y = down ? max(y, bolus.bounds.maxY + 3 + radius) : min(y, bolus.bounds.minY - 3 - radius)
            }
            let dot = CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)
            // A gap around the dot lifts it off the line.
            Self.cutOut(Path(ellipseIn: dot.insetBy(dx: -1.5, dy: -1.5)), filled: true, in: &context)
            context.fill(Path(ellipseIn: dot), with: .color(Self.carbOrange))
            let label = context.resolve(Text("\(Int(carb.units.rounded())) g").font(font).foregroundColor(Self.carbOrange))
            marks.append(DoseMark(x: x, bounds: dot, away: down ? 1 : -1, label: label,
                                  size: label.measure(in: CGSize(width: 200, height: 40)), isBolus: false))
        }
        guard !marks.isEmpty else { return }

        // What a label should not cover: every mark, the labels placed so far and the glucose dots in view.
        var taken = marks.map { $0.bounds.insetBy(dx: -1, dy: -1) }
        let dots = series.readingIndices(from: layout.start - 600, to: layout.end + 600).map { index -> CGRect in
            let reading = series.readings[index]
            return CGRect(x: layout.x(reading.t) - 3, y: layout.y(Double(reading.value)) - 3, width: 6, height: 6)
        }
        let visible = (layout.plot.minX - 2)...(layout.plot.maxX + layout.trailingInset + 2)
        // Boluses first (the dose matters most), each kind left to right.
        for mark in marks.sorted(by: { ($0.isBolus ? 0 : 1, $0.x) < ($1.isBolus ? 0 : 1, $1.x) }) where visible.contains(mark.x) {
            let w = mark.size.width, h = mark.size.height
            let b = mark.bounds
            let off = mark.away < 0 ? b.minY - 1 - h : b.maxY + 1
            let toward = mark.away < 0 ? b.maxY + 1 : b.minY - 1 - h
            var candidates: [CGRect] = []
            for row in 0..<3 {
                candidates.append(CGRect(x: mark.x - w / 2, y: off + mark.away * CGFloat(row) * (h - 1), width: w, height: h))
            }
            candidates.append(CGRect(x: b.maxX + 2, y: b.midY - h / 2, width: w, height: h))
            candidates.append(CGRect(x: b.minX - 2 - w, y: b.midY - h / 2, width: w, height: h))
            for shift in [w / 2 + 3, -(w / 2 + 3)] {
                candidates.append(CGRect(x: mark.x - w / 2 + shift, y: off, width: w, height: h))
            }
            candidates.append(CGRect(x: mark.x - w / 2, y: toward, width: w, height: h))
            // Kept inside the plot sideways (the mark is in view) and under the basal band.
            candidates = candidates.map { rect in
                var rect = rect
                rect.origin.x = min(max(rect.minX, layout.plot.minX + 1), layout.plot.maxX + layout.trailingInset - 1 - w)
                return rect
            }
            var best = candidates[0], bestCost = Double.infinity
            for (rank, rect) in candidates.enumerated() {
                let hit = rect.insetBy(dx: -1, dy: 0)
                var cost = Double(rank) * 2
                cost += Double(taken.filter { $0.intersects(hit) }.count) * 100
                cost += Double(dots.filter { $0.intersects(hit) }.count) * 3
                if rect.minY < layout.plot.minY || rect.maxY > layout.plot.maxY { cost += 60 }
                
                if cost < bestCost { best = rect; bestCost = cost }
            }
            taken.append(best)
            context.draw(mark.label, at: CGPoint(x: best.midX, y: best.midY), anchor: .center)
        }
    }

    private static let dayChipHeight: CGFloat = 17

    /// At each midnight, a chip on top of its line naming the day that starts there: "Dziś", "czw 22 paź".
    private func drawDayChips(_ context: inout GraphicsContext) {
        for tick in hourTicks() where tick.hour == 0 {
            let x = layout.x(tick.t)
            let text = context.resolve(
                Text(ChartText.dayStart(tick.t)).font(.system(size: 10, weight: .semibold)).foregroundColor(Color.primary.opacity(0.8))
            )
            let size = text.measure(in: CGSize(width: 200, height: Self.dayChipHeight))
            let chip = CGRect(x: x - size.width / 2 - 7, y: layout.plot.minY + 3, width: size.width + 14, height: Self.dayChipHeight)
            let shape = Path(roundedRect: chip, cornerRadius: chip.height / 2)
            context.fill(shape, with: .color(DashboardPalette.cardBackground))
            context.fill(shape, with: .color(Color.primary.opacity(0.08)))
            context.stroke(shape, with: .color(Color.primary.opacity(0.14)), lineWidth: 0.5)
            context.draw(text, at: CGPoint(x: x, y: chip.midY), anchor: .center)
        }
    }

    private func drawSelection(_ context: inout GraphicsContext) {
        guard let selectedT, let index = series.nearestReading(to: selectedT, tolerance: 1) else { return }
        let reading = series.readings[index]
        let x = layout.x(reading.t)
        var rule = Path()
        rule.move(to: CGPoint(x: x, y: layout.plot.minY))
        rule.addLine(to: CGPoint(x: x, y: layout.plot.maxY))
        context.stroke(rule, with: .color(Color.primary.opacity(0.35)), lineWidth: 1)

        let center = CGPoint(x: x, y: layout.y(Double(reading.value)))
        context.fill(Path(ellipseIn: CGRect(x: center.x - 8, y: center.y - 8, width: 16, height: 16)), with: .color(DashboardPalette.cardBackground))
        context.fill(
            Path(ellipseIn: CGRect(x: center.x - 5.5, y: center.y - 5.5, width: 11, height: 11)),
            with: .color(DashboardPalette.glucose(DashboardThresholds.glucose(reading.value)))
        )
    }

    /// Hour labels under the plot (the day itself is on the chip at the top of the midnight line).
    private func drawTimeAxis(_ context: inout GraphicsContext) {
        let plot = layout.plot
        let halfLabel: CGFloat = 16
        for tick in hourTicks() {
            let x = layout.x(tick.t)
            // A label sliding past an edge fades out instead of being cut.
            let room = min(x - (plot.minX - 4), plot.maxX + layout.trailingInset - x)
            let opacity = min(1, max(0, (room - halfLabel * 0.3) / (halfLabel * 0.7)))
            guard opacity > 0 else { continue }
            var axis = context
            axis.opacity = Double(opacity)
            axis.draw(
                Text(String(format: "%02d:00", tick.hour)).font(.system(size: 10, weight: tick.hour == 0 ? .semibold : .regular)).foregroundColor(.secondary),
                at: CGPoint(x: x, y: plot.maxY + 3),
                anchor: .top
            )
        }
    }

    private func drawValueAxis(_ context: inout GraphicsContext) {
        // On the chart at the left edge: above the 180 rule, below the 70 rule, where the line is least likely.
        for (value, anchor, shift) in [(180.0, UnitPoint.bottomLeading, CGFloat(-2)), (70.0, UnitPoint.topLeading, CGFloat(2))] where value <= layout.top {
            context.draw(
                Text("\(Int(value))").font(.system(size: 10)).foregroundColor(.secondary),
                at: CGPoint(x: 16, y: layout.y(value) + shift),
                anchor: anchor
            )
        }
    }

    /// Full local hours every 1, 3 or 6 h (by the visible span), a little beyond both edges so labels slide in.
    private func hourTicks() -> [(t: TimeInterval, hour: Int)] {
        let stride = hours <= 4.5 ? 1 : (hours <= 14 ? 3 : 6)
        let zone = TimeZone.current
        // Polish time is a whole number of hours from UTC, so local full hours are UTC full hours; the offset is read
        // per hour, which keeps the labels right across a clock change.
        var t = ((layout.start - 3_600) / 3_600).rounded(.down) * 3_600
        var ticks: [(TimeInterval, Int)] = []
        while t <= layout.end + 3_600 {
            let local = t + TimeInterval(zone.secondsFromGMT(for: Date(timeIntervalSince1970: t)))
            let hour = Int((local / 3_600).rounded(.down).truncatingRemainder(dividingBy: 24))
            if hour % stride == 0 { ticks.append((t, hour)) }
            t += 3_600
        }
        return ticks
    }

    /// A downward triangle with its tip at the point.
    private static func triangle(tipX: CGFloat, tipY: CGFloat, width: CGFloat, height: CGFloat) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: tipX, y: tipY))
        path.addLine(to: CGPoint(x: tipX - width / 2, y: tipY - height))
        path.addLine(to: CGPoint(x: tipX + width / 2, y: tipY - height))
        path.closeSubpath()
        return path
    }

    /// Fritsch–Carlson monotone cubic (what Swift Charts' `.monotone` draws): no overshoot above or below the readings.
    private static func addMonotone(_ path: inout Path, _ points: [CGPoint]) {
        guard let first = points.first else { return }
        path.move(to: first)
        guard points.count > 2 else {
            if points.count == 2 { path.addLine(to: points[1]) }
            return
        }
        func slope(_ i: Int) -> CGFloat {
            let dx = points[i + 1].x - points[i].x
            return dx == 0 ? 0 : (points[i + 1].y - points[i].y) / dx
        }
        func tangent(_ i: Int) -> CGFloat {
            if i == 0 { return slope(0) }
            if i == points.count - 1 { return slope(i - 1) }
            let left = slope(i - 1), right = slope(i)
            guard left * right > 0 else { return 0 }
            return 2 / (1 / left + 1 / right)
        }
        var previousTangent = tangent(0)
        for i in 0..<(points.count - 1) {
            let p0 = points[i], p1 = points[i + 1]
            let dx = (p1.x - p0.x) / 3
            let nextTangent = tangent(i + 1)
            path.addCurve(
                to: p1,
                control1: CGPoint(x: p0.x + dx, y: p0.y + previousTangent * dx),
                control2: CGPoint(x: p1.x - dx, y: p1.y - nextTangent * dx)
            )
            previousTangent = nextTangent
        }
    }
}

/// The chart's dates in Polish.
enum ChartText {
    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.dateFormat = format
        return formatter
    }

    private static let dayFormatter = formatter("d MMM")
    private static let timeFormatter = formatter("HH:mm")
    private static let weekdayFormatter = formatter("EEE, d MMM")
    private static let dayStartFormatter = formatter("EEE d MMM")

    /// "23 paź" (Polish months come with a dot in some locales' data: dropped).
    static func day(_ t: TimeInterval) -> String {
        dayFormatter.string(from: Date(timeIntervalSince1970: t)).replacingOccurrences(of: ".", with: "")
    }

    /// The day starting at a midnight: "Dziś", else "czw 22 paź" (dated like the title above the chart).
    static func dayStart(_ t: TimeInterval) -> String {
        let date = Date(timeIntervalSince1970: t)
        if Calendar.current.isDateInToday(date) { return "Dziś" }
        return dayStartFormatter.string(from: date).replacingOccurrences(of: ".", with: "")
    }

    /// "14:35" today, "wczoraj, 14:35", else "wt, 21 paź, 14:35".
    static func moment(_ t: TimeInterval) -> String {
        let date = Date(timeIntervalSince1970: t)
        let time = timeFormatter.string(from: date)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return time }
        if calendar.isDateInYesterday(date) { return "wczoraj, \(time)" }
        return "\(weekdayFormatter.string(from: date).replacingOccurrences(of: ".", with: "")), \(time)"
    }

    /// The chart card's title: the days on one line, the times under them.
    struct Window: Equatable {
        let days: String
        let times: String
    }

    static func time(_ t: TimeInterval) -> String {
        timeFormatter.string(from: Date(timeIntervalSince1970: t))
    }

    /// The visible window after scrolling back: "Dziś" / "09:10 – 12:10", "22 paź" / "14:10 – 17:10",
    /// "Wczoraj – dziś" / "22:10 – 01:10", "22–23 paź", "31 paź – 1 lis".
    static func window(start: TimeInterval, end: TimeInterval) -> Window {
        let times = "\(time(start)) – \(time(end))"
        return Window(days: days(start: start, end: end), times: times)
    }

    private static func days(start: TimeInterval, end: TimeInterval) -> String {
        let startDate = Date(timeIntervalSince1970: start), endDate = Date(timeIntervalSince1970: end)
        let calendar = Calendar.current
        func relative(_ date: Date) -> String? {
            if calendar.isDateInToday(date) { return "dziś" }
            if calendar.isDateInYesterday(date) { return "wczoraj" }
            return nil
        }
        if calendar.isDate(startDate, inSameDayAs: endDate) {
            return (relative(endDate) ?? day(end)).capitalizedFirst
        }
        if let from = relative(startDate), let to = relative(endDate) {
            return "\(from) – \(to)".capitalizedFirst
        }
        if calendar.isDate(startDate, equalTo: endDate, toGranularity: .month) {
            return "\(calendar.component(.day, from: startDate))–\(day(end))"
        }
        return "\(day(start)) – \(day(end))"
    }
}

// MARK: - Legend

/// A small "?" bubble next to the range picker; tapping it shows the insulin legend in a little popup.
private struct ChartLegendButton: View {
    var showsPrediction = false
    var side: CGFloat = 26
    @State private var isPresented = false

    var body: some View {
        Button {
            isPresented = true
        } label: {
            Image(systemName: "questionmark")
                .font(.system(size: side * 0.5, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: side, height: side)
                .background(Circle().fill(DashboardPalette.chipBackground))
                .contentShape(Rectangle().inset(by: -6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Legenda wykresu")
        // Below the button, over the chart, where there is room for the whole legend; scrolls if it still does not fit.
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            ViewThatFits(in: .vertical) {
                InsulinLegend(showsPrediction: showsPrediction)
                    .padding(14)
                ScrollView {
                    InsulinLegend(showsPrediction: showsPrediction)
                        .padding(14)
                }
            }
            .presentationCompactAdaptation(.popover)
        }
    }
}

/// What the chart's marks and gestures mean (shown from the "?" bubble).
private struct InsulinLegend: View {
    var showsPrediction = false

    private static let blue = DashboardPalette.insulin
    private static let purple = Color(red: 0.557, green: 0.486, blue: 0.941)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsPrediction {
                row(
                    RoundedRectangle(cornerRadius: 2).fill(Color.secondary.opacity(0.35)).frame(width: 14, height: 11),
                    title: PredictionExperimentText.featureName,
                    detail: PredictionExperimentText.legend
                )
            }
            row(
                Image(systemName: "arrowtriangle.down.fill").font(.system(size: 13)).foregroundStyle(Self.blue),
                title: "Bolus",
                detail: "ręczny bolus nad linią glukozy w chwili podania, nad nim dawka w jednostkach"
            )
            row(
                Image(systemName: "arrowtriangle.down.fill").font(.system(size: 8)).foregroundStyle(Self.purple),
                title: "SMB",
                detail: "mikrobolusy pętli, na dole wykresu; na małym wykresie bez liczby"
            )
            row(
                Circle().fill(Color.orange).frame(width: 11, height: 11),
                title: "Węglowodany",
                detail: "kropka na linii glukozy w chwili wpisu, obok niej gramy"
            )
            row(
                Rectangle().fill(Self.blue.opacity(0.18)).frame(width: 22, height: 7),
                title: "Baza",
                detail: "jasny pas na dole wykresu: wyższy przy wyższej bazie; szara przerywana linia to baza z profilu, więc baza tymczasowa nad nią lub pod nią widać od razu"
            )
            row(
                Image(systemName: "hand.draw").font(.system(size: 15)).foregroundStyle(.secondary),
                title: "Gesty",
                detail: "przesuń w bok, by cofnąć się w czasie; przytrzymaj palec, by zobaczyć godzinę, glukozę, IOB, COB i bazę"
            )
        }
        .frame(width: 260, alignment: .leading)
    }

    private func row(_ swatch: some View, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            swatch
                .frame(width: 40, alignment: .center)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
