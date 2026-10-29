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

    @State private var scroll = ChartScroll()
    @State private var mode = DragMode.idle
    @State private var pressTask: Task<Void, Never>?
    @State private var fingerX: CGFloat = 0
    @State private var selectedT: TimeInterval?
    /// Animated together when the range changes (a zoom) or a higher reading scrolls in.
    @State private var span: TimeInterval
    @State private var yMax: Double = 220

    init(viewModel: DashboardViewModel, store: DashboardChartStore, now: Date, pull: PullModel) {
        self.viewModel = viewModel
        self.store = store
        self.now = now
        self.pull = pull
        _span = State(initialValue: Self.seconds(viewModel.chartRange))
    }

    private static func seconds(_ range: DashboardChartRange) -> TimeInterval {
        Double(range.hours) * 3_600
    }

    /// The right edge when following now: now, or the newest reading if the clock has not caught up with it yet.
    private var liveEnd: TimeInterval {
        max(now.timeIntervalSince1970, store.series.readings.last?.t ?? 0)
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
            VStack(spacing: 6) {
                HStack(spacing: 8) {
                    let title = title(end: end)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title.days)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(title.times)
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                    .lineLimit(1)
                    .fixedSize()
                    .layoutPriority(1)
                    Spacer(minLength: 4)
                    ChartRangePicker(viewModel: viewModel)
                    // The legend only on request, in a bubble next to the range picker.
                    ChartLegendButton()
                }
                GeometryReader { geometry in
                    ChartPlot(
                        series: store.series,
                        end: end,
                        span: span,
                        yMax: yMax,
                        size: geometry.size,
                        selectedT: selectedT,
                        showsLoading: store.isLoadingOlder && (store.historyFrom.map { end - span < $0 } ?? true)
                    )
                    .contentShape(Rectangle())
                    .gesture(dragGesture(size: geometry.size))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(accessibilityText)
                    .overlay(alignment: .topTrailing) {
                        if !scroll.live, mode != .selecting {
                            NowButton(action: jumpToNow)
                                .padding(.top, 4)
                                .transition(.opacity.combined(with: .scale(scale: 0.85)))
                        }
                    }
                    .animation(.snappy(duration: 0.25), value: scroll.live)
                }
                .frame(minHeight: 110, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(DashboardPalette.cardBackground))
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
        .onChange(of: restingEnd) { _, end in
            store.ensureLoaded(visibleStart: end - span, span: span)
        }
        .onChange(of: span) { _, span in
            store.ensureLoaded(visibleStart: restingEnd - span, span: span)
        }
    }

    /// The top of the glucose scale: 220 mg/dL while nothing in the window goes past it (the line then fills the chart
    /// instead of an empty band up to 300), else above the highest reading (in steps of 25, so it does not twitch while
    /// scrolling).
    private var yTarget: Double {
        let end = restingEnd
        let highest = store.series.maxValue(from: end - span, to: end) ?? 0
        return max(Self.lowestTop, ((Double(highest) + 10) / 25).rounded(.up) * 25)
    }

    static let lowestTop = 220.0

    // MARK: Title

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
                let layout = ChartLayout(size: size, end: scroll.end(at: .now, liveEnd: liveEnd), span: span, yMax: yMax)
                switch mode {
                case .idle:
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
                let layout = ChartLayout(size: size, end: scroll.end(at: .now, liveEnd: liveEnd), span: span, yMax: yMax)
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
            }
    }

    /// The reading on the finger's vertical line (the nearest one, within a few minutes or a few points).
    private func select(x: CGFloat, size: CGSize) {
        let layout = ChartLayout(size: size, end: scroll.end(at: .now, liveEnd: liveEnd), span: span, yMax: yMax)
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
private struct ChartRangePicker: View {
    @ObservedObject var viewModel: DashboardViewModel

    var body: some View {
        Picker("Zakres", selection: $viewModel.chartRange) {
            ForEach(DashboardChartRange.allCases) { range in
                Text(range.rawValue).tag(range)
            }
        }
        .pickerStyle(.segmented)
        .controlSize(.small)
        .frame(width: 150)
    }
}

/// Back to the newest reading after scrolling back.
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
    static let leadingGutter: CGFloat = 28
    static let trailingInset: CGFloat = 8
    static let axisHeight: CGFloat = 16
    static let bottomValue = -44.0
    static let doseBaseline = -14.0
    /// Room above the glucose for the basal band.
    static let basalBand = 38.0
    static let maxBasalRate = 1.6

    let plot: CGRect
    let start: TimeInterval
    let end: TimeInterval
    let span: TimeInterval
    let top: Double

    init(size: CGSize, end: TimeInterval, span: TimeInterval, yMax: Double) {
        plot = CGRect(
            x: Self.leadingGutter,
            y: 0,
            width: max(1, size.width - Self.leadingGutter - Self.trailingInset),
            height: max(1, size.height - Self.axisHeight)
        )
        self.end = end
        self.span = span
        start = end - span
        top = yMax + Self.basalBand
    }

    func x(_ t: TimeInterval) -> CGFloat {
        plot.minX + CGFloat((t - start) / span) * plot.width
    }

    func y(_ value: Double) -> CGFloat {
        plot.maxY - CGFloat((value - Self.bottomValue) / (top - Self.bottomValue)) * plot.height
    }

    func time(atX x: CGFloat) -> TimeInterval {
        start + Double((x - plot.minX) / plot.width) * span
    }
}

/// The chart itself: one Canvas and the selection bubble. Animatable, so a zoom (range change) and a new y scale
/// glide instead of jumping.
private struct ChartPlot: View, Animatable {
    let series: DashboardChartSeries
    let end: TimeInterval
    var span: TimeInterval
    var yMax: Double
    let size: CGSize
    let selectedT: TimeInterval?
    let showsLoading: Bool

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(span, yMax) }
        set {
            span = newValue.first
            yMax = newValue.second
        }
    }

    var body: some View {
        let layout = ChartLayout(size: size, end: end, span: span, yMax: yMax)
        Canvas { context, _ in
            ChartRenderer(layout: layout, series: series, selectedT: selectedT).draw(in: &context)
        }
        .overlay(alignment: .topLeading) {
            if let selectedT, let index = series.nearestReading(to: selectedT, tolerance: 1) {
                let reading = series.readings[index]
                BubblePlacement(
                    pointX: layout.x(reading.t),
                    pointY: layout.y(Double(reading.value)),
                    top: layout.plot.minY + 2
                ) {
                    SelectionBubble(reading: reading, loop: series.loopValues(at: reading.t), basal: series.basalRate(at: reading.t))
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
                    .offset(x: ChartLayout.leadingGutter + 6, y: -ChartLayout.axisHeight / 2)
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
            // The dashboard chips' icons instead of names: the bubble stays narrow with the basal as a third value.
            HStack(spacing: 10) {
                metric(Image(systemName: "drop.fill").font(.caption2.weight(.semibold)).foregroundStyle(DashboardPalette.insulin), name: "IOB", value: loop?.iob.map { "\(DashboardFormat.iob($0)) j" })
                metric(Image(systemName: "fork.knife").font(.caption2.weight(.semibold)).foregroundStyle(.orange), name: "COB", value: loop?.cob.map { "\(Int($0.rounded())) g" })
                metric(SquareWave().stroke(ChartRenderer.basalBlue, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)).frame(width: 11, height: 9), name: "Baza", value: basal.map { "\(DashboardFormat.dose($0)) j/h" })
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
        .shadow(color: .black.opacity(0.14), radius: 10, y: 4)
    }

    private func metric(_ icon: some View, name: String, value: String?) -> some View {
        HStack(spacing: 3) {
            icon
            Text(value ?? "—")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) \(value ?? "brak")")
    }
}

/// The basal's mark in the bubble: a square wave, as the basal's steps on the chart (SF Symbols has none).
private struct SquareWave: Shape {
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

    private static let bolusBlue = Color(red: 0.039, green: 0.424, blue: 1.0)
    /// Lighter than the bolus blue, so the band reads on black too.
    static let basalBlue = Color(red: 0.36, green: 0.61, blue: 1.0)
    private static let smbPurple = Color(red: 0.557, green: 0.486, blue: 0.941)
    private static let smbLabel = Color(red: 0.435, green: 0.357, blue: 0.839)
    /// A gap longer than this breaks the line (a sensor change, a lost signal).
    private static let lineGap: TimeInterval = 16 * 60

    private var hours: Double { layout.span / 3_600 }

    func draw(in context: inout GraphicsContext) {
        let plot = layout.plot
        var plotContext = context
        // The trailing inset belongs to the plot too: the newest reading's ring at the right edge is not cut.
        plotContext.clip(to: Path(CGRect(x: plot.minX, y: plot.minY, width: plot.width + ChartLayout.trailingInset, height: plot.height)))

        drawBackground(&plotContext)
        drawBasal(&plotContext)
        drawGlucose(&plotContext)
        drawInsulin(&plotContext)
        drawDayChips(&plotContext)
        drawSelection(&plotContext)

        drawTimeAxis(&context)
        drawValueAxis(&context)
    }

    private func drawBackground(_ context: inout GraphicsContext) {
        let plot = layout.plot
        let band = CGRect(x: plot.minX, y: layout.y(180), width: plot.width, height: layout.y(70) - layout.y(180))
        context.fill(Path(band), with: .color(DashboardPalette.green.opacity(0.08)))

        var grid = Path()
        var midnights = Path()
        for tick in hourTicks() {
            let x = layout.x(tick.t)
            if tick.hour == 0 {
                // Where a day starts: a firmer line from under the day's chip to the axis.
                midnights.move(to: CGPoint(x: x, y: plot.minY + Self.dayChipHeight + 3))
                midnights.addLine(to: CGPoint(x: x, y: plot.maxY))
            } else {
                grid.move(to: CGPoint(x: x, y: plot.minY))
                grid.addLine(to: CGPoint(x: x, y: plot.maxY))
            }
        }
        context.stroke(grid, with: .color(Color.secondary.opacity(0.2)), lineWidth: 0.5)
        context.stroke(midnights, with: .color(Color.primary.opacity(0.28)), lineWidth: 1)

        let dash = StrokeStyle(lineWidth: 1, dash: [3, 3])
        // The 250 line only when the scale reaches it (a lower scale ends at 220).
        for (value, color) in [(250.0, DashboardPalette.red.opacity(0.45)), (180.0, DashboardPalette.yellow.opacity(0.7)), (70.0, DashboardPalette.red.opacity(0.7))] where value <= layout.top - ChartLayout.basalBand {
            var rule = Path()
            rule.move(to: CGPoint(x: plot.minX, y: layout.y(value)))
            rule.addLine(to: CGPoint(x: plot.maxX, y: layout.y(value)))
            context.stroke(rule, with: .color(color), style: dash)
        }
    }

    /// A soft band hanging from the top edge, deeper for a higher rate.
    private func drawBasal(_ context: inout GraphicsContext) {
        var band = Path()
        var edge = Path()
        let topY = layout.y(layout.top)
        let start = DashboardChartSeries.lowerBound(series.basal, layout.start - 86_400, key: { $0.start })
        for run in series.basal[start...] {
            if run.start >= layout.end { break }
            guard run.end > layout.start else { continue }
            let depth = layout.top - (ChartLayout.basalBand - 6) * min(run.rate, ChartLayout.maxBasalRate) / ChartLayout.maxBasalRate
            let x0 = layout.x(max(run.start, layout.start - 60)), x1 = layout.x(min(run.end, layout.end + 60))
            let depthY = layout.y(depth)
            band.addRect(CGRect(x: x0, y: topY, width: x1 - x0, height: depthY - topY))
            if run.rate > 0 {
                edge.move(to: CGPoint(x: x0, y: depthY))
                edge.addLine(to: CGPoint(x: x1, y: depthY))
            }
        }
        context.fill(band, with: .color(Self.basalBlue.opacity(0.24)))
        context.stroke(edge, with: .color(Self.basalBlue.opacity(0.7)), lineWidth: 1.2)
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
        context.stroke(line, with: .color(Color.secondary.opacity(0.35)), lineWidth: 1.2)

        // The dots, one path per colour.
        let diameter = dotDiameter
        var normal = Path(), warning = Path(), alarm = Path()
        for index in range {
            let reading = readings[index]
            let center = CGPoint(x: layout.x(reading.t), y: layout.y(Double(reading.value)))
            let rect = CGRect(x: center.x - diameter / 2, y: center.y - diameter / 2, width: diameter, height: diameter)
            switch DashboardThresholds.glucose(reading.value) {
            case .normal: normal.addEllipse(in: rect)
            case .warning: warning.addEllipse(in: rect)
            case .alarm: alarm.addEllipse(in: rect)
            }
        }
        context.fill(normal, with: .color(DashboardPalette.glucose(.normal)))
        context.fill(warning, with: .color(DashboardPalette.glucose(.warning)))
        context.fill(alarm, with: .color(DashboardPalette.glucose(.alarm)))

        // The newest reading in a ring.
        if let last = readings.last, last.t >= layout.start, last.t <= layout.end + 60 {
            let center = CGPoint(x: layout.x(last.t), y: layout.y(Double(last.value)))
            let ring = Path(ellipseIn: CGRect(x: center.x - 4.6, y: center.y - 4.6, width: 9.2, height: 9.2))
            context.stroke(ring, with: .color(DashboardPalette.glucose(DashboardThresholds.glucose(last.value))), lineWidth: 2.5)
        }
    }

    /// 5.3 pt on 3 h, 3.9 on 12 h, 3 on 24 h (the old chart's symbol sizes), smoothly in between while zooming.
    private var dotDiameter: CGFloat {
        let h = hours
        if h <= 3 { return 5.3 }
        if h <= 12 { return 5.3 - CGFloat(h - 3) / 9 * 1.4 }
        return max(3, 3.9 - CGFloat(h - 12) / 12 * 0.9)
    }

    /// SMBs: small purple triangles, the dose above each on short ranges, sums per hour (two on 24 h) below on longer
    /// ones. Boluses: bigger blue triangles with the dose above, lifted a row when it would touch the previous label; on
    /// longer ranges boluses whose labels would overlap are one triangle with their sum.
    private func drawInsulin(_ context: inout GraphicsContext) {
        let baseline = layout.y(ChartLayout.doseBaseline)
        let perDoseLabels = hours <= 4.5
        let smbSize: CGFloat = perDoseLabels ? 7 : 5.5

        var smbTriangles = Path()
        let from = layout.start - 3_600, to = layout.end + 3_600
        for index in series.doseIndices(series.smbs, from: from, to: to) {
            let smb = series.smbs[index]
            let x = layout.x(smb.t)
            smbTriangles.addPath(Self.triangle(tipX: x, tipY: baseline, width: smbSize, height: smbSize * 0.85))
            if perDoseLabels {
                context.draw(
                    Text(DashboardFormat.dose(smb.units)).font(.system(size: 9, weight: .bold)).foregroundColor(Self.smbLabel),
                    at: CGPoint(x: x, y: baseline - smbSize * 0.85 - 1),
                    anchor: .bottom
                )
            }
        }
        context.fill(smbTriangles, with: .color(Self.smbPurple))
        if !perDoseLabels {
            for sum in series.smbSums(from: from, to: to, bucket: hours > 15 ? 7_200 : 3_600) {
                context.draw(
                    Text(DashboardFormat.dose(sum.units)).font(.system(size: 9, weight: .bold)).foregroundColor(Self.smbLabel),
                    at: CGPoint(x: layout.x(sum.t), y: baseline + 2),
                    anchor: .top
                )
            }
        }

        // On 12 h and 24 h boluses close together are one mark: their sum at their dose-weighted time.
        var bolusTriangles = Path()
        let bolusRange = Array(series.doseIndices(series.boluses, from: from, to: to))
        let marks: [DashboardChartSeries.Dose] = perDoseLabels
            ? bolusRange.map { series.boluses[$0] }
            : DashboardChartSeries.clusters(at: bolusRange.map { Double(layout.x(series.boluses[$0].t)) }, minimumGap: 26).map { group in
                let doses = group.map { series.boluses[bolusRange[$0]] }
                let units = doses.reduce(0) { $0 + $1.units }
                let t = units > 0 ? doses.reduce(0) { $0 + $1.t * $1.units } / units : doses[0].t
                return DashboardChartSeries.Dose(t: t, units: units)
            }
        var lifted = DashboardChartSeries.liftedLabels(at: marks.map { Double(layout.x($0.t)) }, minimumGap: 26)
        if perDoseLabels {
            // Above an SMB's dose too: a row higher than that label.
            for (offset, mark) in marks.enumerated() where !lifted[offset] {
                let reach = 22 * layout.span / Double(layout.plot.width)
                lifted[offset] = !series.doseIndices(series.smbs, from: mark.t - reach, to: mark.t + reach).isEmpty
            }
        }
        for (offset, mark) in marks.enumerated() {
            let x = layout.x(mark.t)
            bolusTriangles.addPath(Self.triangle(tipX: x, tipY: baseline, width: 11, height: 9.5))
            context.draw(
                Text(DashboardFormat.dose(mark.units)).font(.system(size: 10, weight: .heavy)).foregroundColor(Self.bolusBlue),
                at: CGPoint(x: x, y: baseline - 9.5 - (lifted[offset] ? 13 : 1)),
                anchor: .bottom
            )
        }
        context.fill(bolusTriangles, with: .color(Self.bolusBlue))
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
            let room = min(x - (plot.minX - 4), plot.maxX + ChartLayout.trailingInset - x)
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
        for value in [70.0, 180.0, 250.0] where value <= layout.top - ChartLayout.basalBand {
            context.draw(
                Text("\(Int(value))").font(.system(size: 10)).foregroundColor(.secondary),
                at: CGPoint(x: layout.plot.minX - 5, y: layout.y(value)),
                anchor: .trailing
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
    @State private var isPresented = false

    var body: some View {
        Button {
            isPresented = true
        } label: {
            Image(systemName: "questionmark")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(DashboardPalette.chipBackground))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Legenda wykresu")
        // Below the button, over the chart, where there is room for the whole legend; scrolls if it still does not fit.
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            ViewThatFits(in: .vertical) {
                InsulinLegend()
                    .padding(14)
                ScrollView {
                    InsulinLegend()
                        .padding(14)
                }
            }
            .presentationCompactAdaptation(.popover)
        }
    }
}

/// What the chart's marks and gestures mean (shown from the "?" bubble).
private struct InsulinLegend: View {
    private static let blue = Color(red: 0.039, green: 0.424, blue: 1.0)
    private static let purple = Color(red: 0.557, green: 0.486, blue: 0.941)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            row(
                Image(systemName: "arrowtriangle.down.fill").font(.system(size: 13)).foregroundStyle(Self.blue),
                title: "Bolus",
                detail: "ręczny bolus, nad nim dawka"
            )
            row(
                Image(systemName: "arrowtriangle.down.fill").font(.system(size: 8)).foregroundStyle(Self.purple),
                title: "SMB",
                detail: "mikrobolusy pętli"
            )
            row(
                Rectangle().fill(Self.blue.opacity(0.18)).frame(width: 22, height: 7),
                title: "Baza",
                detail: "pas u góry wykresu: głębszy przy wyższej bazie, znika przy wstrzymaniu"
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
