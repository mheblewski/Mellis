import Combine
import SwiftUI
import GlucoMindCore

/// The first tab: a glance at the patient with no scrolling. The glucose with IOB and COB, the chart, and time in range
/// next to the equipment (only what needs attention), the loop and the last bolus. (The "Teraz" strip between the
/// glucose and the chart was dropped on 2026-10-23: it mostly repeated the tiles and the meals tab's badge.)
struct DashboardView: View {
    let apiClient: APIClient
    let patientID: String
    let patientName: String
    /// The caregiver has more than one patient, so the name opens the patient list.
    let canChangePatient: Bool
    let onShowPatientSelection: () -> Void
    let onOpenNotification: (_ pushUserInfo: [AnyHashable: Any]) -> Void
    let onSignOut: () async -> Void
    /// The home-screen widget's equipment field was tapped: the equipment list opens.
    let equipmentRequest: UUID?
    let onEquipmentRequestHandled: (UUID) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveUpdates) private var liveUpdates
    @StateObject private var viewModel: DashboardViewModel
    /// The tab is on screen (a hidden tab does not read on a return; it reads when shown, through its loop).
    @State private var isOnScreen = false
    /// The chart's data with its scrolled-back history. Plain @State like `pull`: only the chart card observes it, so
    /// loading history never re-renders the rest of the screen.
    @State private var chartStore: DashboardChartStore
    /// Pull to refresh, handled here instead of by a scroll view: how far the finger pulled the cards (rubber-banded)
    /// and whether it is still down. Each card springs after it on its own, which gives the cascade.
    /// Held as plain @State (not @StateObject): the screen itself does not observe it, so a drag frame re-renders only
    /// the thin wrappers that move the cards, never the cards' contents (the chart above all).
    @State private var pull = PullModel()
    @State private var showsEquipment = false
    @State private var showsTimeInRange = false
    /// The newest reading the home-screen widget was told about.
    @State private var widgetReading: String?

    init(
        patient: AccessiblePatient,
        apiClient: APIClient,
        canChangePatient: Bool,
        onShowPatientSelection: @escaping () -> Void,
        onOpenNotification: @escaping (_ pushUserInfo: [AnyHashable: Any]) -> Void,
        onSignOut: @escaping () async -> Void,
        equipmentRequest: UUID? = nil,
        onEquipmentRequestHandled: @escaping (UUID) -> Void = { _ in }
    ) {
        self.apiClient = apiClient
        self.patientID = patient.patient_id
        self.patientName = patient.display_name
        self.canChangePatient = canChangePatient
        self.onShowPatientSelection = onShowPatientSelection
        self.onOpenNotification = onOpenNotification
        self.onSignOut = onSignOut
        self.equipmentRequest = equipmentRequest
        self.onEquipmentRequestHandled = onEquipmentRequestHandled
        _viewModel = StateObject(wrappedValue: DashboardViewModel(apiClient: apiClient, patientID: patient.patient_id))
        _chartStore = State(initialValue: DashboardChartStore(apiClient: apiClient, patientID: patient.patient_id))
    }

    var body: some View {
        // The top bar is a real toolbar, so the bell and settings bubble is the very one the chat and meals get.
        NavigationStack {
            // The cards fill the space above the tab bar and the chart takes whatever the others leave, so the
            // screen never scrolls. Only the cards are pulled down to refresh; the top bar stays put.
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .overlay(alignment: .top) {
                    PullIndicator(pull: pull)
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 12)
                .contentShape(Rectangle())
                .simultaneousGesture(pullGesture)
                .background(DashboardPalette.pageBackground)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    topBar
                }
                #endif
                .sheet(isPresented: $showsEquipment) {
                    if let dashboard = viewModel.dashboard {
                        EquipmentSheet(items: DashboardGlance.equipment(dashboard, now: .now))
                    }
                }
                .sheet(isPresented: $showsTimeInRange) {
                    if let dashboard = viewModel.dashboard {
                        TimeInRangeSheet(
                            dayBands: DashboardGlance.rangeBands(dashboard.readings, hours: 24, now: .now),
                            dayCoverage: DashboardGlance.sensorCoverage(dashboard.readings, hours: 24, now: .now),
                            load: { [apiClient, patientID] days in try await apiClient.getDashboardTimeInRange(patientID: patientID, days: days) }
                        )
                    }
                }
        }
        .overlay {
            if viewModel.dashboard == nil, viewModel.errorMessage == nil {
                BrandSpinner()
            }
        }
        // Every refresh's last 24 h go on top of the chart's history.
        .onReceive(viewModel.$dashboard) { dashboard in
            if let dashboard {
                chartStore.apply(dashboard)
                LaunchSplashController.shared.markContentReady()
            }
            // A new reading while the app is open: the widget reloads now (free in the foreground, not from its budget).
            if let reading = dashboard?.glucose?.observed_at, reading != widgetReading {
                widgetReading = reading
                HomeWidgetReloader.reload()
            }
        }
        .onReceive(viewModel.$errorMessage) { error in
            if error != nil { LaunchSplashController.shared.markContentReady() }
        }
        .onChange(of: equipmentRequest, initial: true) { _, request in
            guard let request else { return }
            showsEquipment = true
            onEquipmentRequestHandled(request)
        }
        // The tab's loop while it is on screen and the app is in the foreground (stale-ui.v1): started again on every
        // return and tab switch; after inactivity the glucose is dimmed with a spinner until the new read is in.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await viewModel.run()
        }
        .onAppear { isOnScreen = true }
        .onDisappear { isOnScreen = false }
        #if canImport(UIKit)
        // A read on every foreground transition, not only through SwiftUI restarting the task above (a read already
        // running is joined, never doubled).
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            guard isOnScreen else { return }
            Task { await viewModel.refreshAfterReturn() }
        }
        #endif
        // The live stream came back (reconnect after the background or a dropped connection): events may have been
        // missed while it was down, so the dashboard reads again too.
        .onReceive(liveUpdates?.changes.filter { $0 == .resync }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
            guard isOnScreen, scenePhase == .active else { return }
            Task { await viewModel.refreshAfterReturn() }
        }
    }

    /// Left: the hummingbird and the patient (a chevron when there are more patients), right: the bell and settings.
    #if os(iOS)
    @ToolbarContentBuilder
    private var topBar: some ToolbarContent {
        BubblelessToolbarItem(placement: .topBarLeading) {
            patientTitle
        }
        // No "Odśwież": the cards refresh by pulling them.
        ToolbarItem(placement: .topBarTrailing) {
            TopBarTrailingControls(
                apiClient: apiClient,
                patientID: patientID,
                onShowPatientSelection: onShowPatientSelection,
                onOpenNotification: onOpenNotification,
                onSignOut: onSignOut
            )
        }
    }
    #endif

    private var patientTitle: some View {
        PatientTitle(name: patientName, canChangePatient: canChangePatient, onShowPatientSelection: onShowPatientSelection)
    }

    private var pullGesture: some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                let distance = value.translation.height
                guard !pull.isSuppressed, distance > abs(value.translation.width) else {
                    pull.drag(distance: 0) { await viewModel.refreshFromPull() }
                    return
                }
                pull.drag(distance: distance) { await viewModel.refreshFromPull() }
            }
            .onEnded { _ in
                pull.release()
            }
    }

    @ViewBuilder
    private var content: some View {
        if let dashboard = viewModel.dashboard {
            // Ages ("3 min temu", "1 d 4 h") keep counting between refreshes.
            TimelineView(.periodic(from: .now, by: 15)) { context in
                let equipment = DashboardGlance.equipment(dashboard, now: context.date)
                VStack(spacing: 14) {
                    GlucoseHero(glucose: dashboard.glucose, loop: dashboard.loop, now: context.date, pull: pull,
                                freshness: viewModel.freshness, refreshFailed: viewModel.errorMessage != nil) {
                        Task { await viewModel.retryNow() }
                    }
                    .pullCascade(pull, step: 0)
                    ChartCard(viewModel: viewModel, store: chartStore, now: context.date, pull: pull)
                        .frame(minHeight: 150, maxHeight: .infinity)
                        .pullCascade(pull, step: 1)
                    // Two rows of two: time in range and equipment, then the loop and the last bolus.
                    VStack(spacing: 10) {
                    HStack(spacing: 10) {
                        TimeInRangeTile(
                            tir: dashboard.time_in_range,
                            bands: DashboardGlance.rangeBands(dashboard.readings, hours: dashboard.time_in_range?.hours ?? 24, now: context.date)
                        ) {
                            showsTimeInRange = true
                        }
                        EquipmentTile(attention: DashboardGlance.attention(equipment), hasData: !equipment.isEmpty) {
                            showsEquipment = true
                        }
                    }
                    HStack(spacing: 10) {
                        LoopTile(loop: DashboardGlance.loop(dashboard, now: context.date))
                        LastBolusTile(bolus: DashboardGlance.lastBolus(dashboard), now: context.date)
                    }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .pullCascade(pull, step: 2)
                    // The server is still reading the Nightscout history (a new install or restore, 1.0.5): one quiet
                    // line, gone once the import is complete.
                    if let history = dashboard.nightscout_history?.rowText {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text(history)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("dashboard.historyImport")
                    }
                    // A failed refresh is said in the glucose's own line (GlucoseHero), so nothing below moves.
                }
            }
        } else if viewModel.errorMessage != nil {
            ContentUnavailableView {
                Label("Brak danych", systemImage: "exclamationmark.triangle")
            } description: {
                Text("Nie udało się wczytać danych z Nightscout. Sprawdź połączenie i spróbuj ponownie.")
            } actions: {
                Button("Spróbuj ponownie") {
                    Task { await viewModel.refresh() }
                }
                .buttonStyle(.bordered)
            }
            .padding(.top, 60)
        } else {
            // The spinner is laid over the whole screen (see body), not under the top bar.
            Color.clear
        }
    }
}

#if os(iOS)
/// A toolbar item without the iOS 26 glass bubble (the logo is not a button).
struct BubblelessToolbarItem<Content: View>: ToolbarContent {
    let placement: ToolbarItemPlacement
    @ViewBuilder let content: () -> Content

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: placement, content: content)
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: placement, content: content)
        }
    }
}
#endif

/// The hummingbird and the patient, top left on the dashboard and the Bolus tab; a chevron opens the patient list when
/// there are more patients.
struct PatientTitle: View {
    let name: String
    let canChangePatient: Bool
    let onShowPatientSelection: () -> Void

    /// The bar's width less the logo, the chevron, the bell-and-settings bubble and the margins.
    static var maxNameWidth: CGFloat {
        #if os(iOS)
        let width = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen.bounds.width }.first ?? 390
        return max(80, width - 210)
        #else
        return 240
        #endif
    }

    var body: some View {
        let label = HStack(spacing: 7) {
            Image("Logo")
                .resizable()
                .scaledToFit()
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)
            // Its own width up to what leaves the logo, the chevron and the bell and settings room: a longer name ends in
            // "…". Without the cap the toolbar squeezed it to nothing; with its full width a long name pushed the
            // controls into the "⋯" menu.
            Text(name)
                .font(.title3.weight(.bold))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: Self.maxNameWidth, alignment: .leading)
                .fixedSize()
            if canChangePatient {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
        if canChangePatient {
            Button(action: onShowPatientSelection) { label.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel("Pacjent: \(name)")
                .accessibilityHint("Zmień pacjenta")
        } else {
            label.accessibilityElement(children: .combine).accessibilityLabel("Pacjent: \(name)")
        }
    }
}

// MARK: - Glucose

/// The glucose in the middle, big, with the trend and the 5-minute change; under it one line: unit, age (yellow or red
/// when old), IOB and COB.
private struct GlucoseHero: View {
    let glucose: DashboardGlucose?
    let loop: DashboardLoop?
    let now: Date
    /// Only for the refresh spinner, which observes the refresh on its own (not this view).
    let pull: PullModel
    /// stale-ui.v1: refreshing after a return (dimmed, spinner) or failed (dimmed, "nie udało się odświeżyć").
    var freshness: DashboardFreshness = .fresh
    /// The last read failed: the info line says so and retries on a tap.
    var refreshFailed = false
    var onRetry: () -> Void = {}

    /// The value and arrow dimmed in place (StaleReading, as on the widgets): a refresh after a return is running or
    /// failed, or the reading itself is over 15 min old.
    private var isStale: Bool {
        freshness.dimsGlucose || StaleReading.isStale(observedAt: glucose?.observedAt, now: now)
    }

    var body: some View {
        VStack(spacing: 2) {
            HStack(alignment: .center, spacing: 10) {
                if let glucose {
                    let level = DashboardThresholds.glucose(glucose.value)
                    Text("\(glucose.value)")
                        .font(.system(size: 92, weight: .bold))
                        .monospacedDigit()
                        .tracking(-2)
                        // A new reading rolls the digits to their new value.
                        .contentTransition(.numericText(value: Double(glucose.value)))
                        .animation(.snappy, value: glucose.value)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                        .foregroundStyle(DashboardPalette.glucose(level))
                        .staleDimmed(isStale)
                        .animation(.easeInOut(duration: 0.25), value: isStale)
                    trend(glucose, level: level)
                } else {
                    Text("—")
                        .font(.system(size: 92, weight: .bold))
                        .foregroundStyle(.secondary)
                }
            }
            Group {
                if refreshFailed {
                    // The same line, so nothing moves: the age, then the failure with a retry.
                    Button(action: onRetry) {
                        // Text only (no inline symbol): the line keeps its height, so the chips below never move.
                        (info + Text(" · ") + Text("nie udało się odświeżyć").foregroundStyle(DashboardPalette.red).fontWeight(.semibold)
                            + Text(" · ") + Text("Ponów").foregroundStyle(Brand.interactive).fontWeight(.semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Nie udało się odświeżyć. Spróbuj ponownie")
                } else {
                    info
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            // Insulin and carbs on board, as chips of their own: read at a glance next to the glucose.
            HStack(spacing: 8) {
                loopChip(icon: "drop.fill", tint: DashboardPalette.insulin, name: "IOB", value: loop?.iob_units.map { "\(DashboardFormat.iob($0)) j" })
                loopChip(icon: "fork.knife", tint: .orange, name: "COB", value: loop?.cob_grams.map { "\(Int($0.rounded())) g" })
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity)
        // Without a reading there is no trend circle to turn into the spinner: it waits at the side then.
        .overlay(alignment: .trailing) {
            if glucose == nil {
                PullRefreshSpinner(pull: pull)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var info: Text {
        var line = Text("mg/dL")
        if let observedAt = glucose?.observedAt {
            let minutes = DashboardFormat.wholeMinutes(since: observedAt, now: now)
            let level = DashboardThresholds.readingAge(minutes: minutes)
            line = line + Text(" · ") + Text(minutes < 1 ? "0 min temu" : StaleReading.ageText(minutes: minutes))
                .foregroundStyle(level == .normal ? Color.secondary : DashboardPalette.color(level))
                .fontWeight(level == .normal ? .regular : .semibold)
        }
        return line
    }

    /// "IOB 1,85 j" in a capsule: the icon in the dose's colour, the value large and bold ("—" when the loop has none).
    private func loopChip(icon: String, tint: Color, name: String, value: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tint)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
            Text(name)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value ?? "—")
                .font(.system(size: 19, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(value == nil ? Color.secondary : Color.primary)
        }
        .lineLimit(1)
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(Capsule().fill(DashboardPalette.cardBackground))
        .accessibilityElement(children: .combine)
    }

    /// The trend arrow in a translucent circle (tinted yellow or red with the value) with the 5-minute change under
    /// it, as one block centred beside the digits.
    @ViewBuilder
    private func trend(_ glucose: DashboardGlucose, level: DashboardLevel) -> some View {
        VStack(spacing: 6) {
            // Nightscout's direction, else from the 5-minute change: the same rule as the Bolus tab and the chat.
            TrendBadge(
                direction: GlucoseTrend.direction(nightscout: glucose.direction, delta: glucose.delta.map(Double.init)),
                level: level,
                activity: pull.activity,
                refreshing: freshness == .refreshing,
                dimmed: isStale
            )
            if let delta = glucose.delta {
                Text(DashboardFormat.signedDelta(delta))
                    .font(.system(size: 22, weight: .bold))
                    .monospacedDigit()
                    .staleDimmed(isStale)
                    .accessibilityLabel("Zmiana \(DashboardFormat.signedDelta(delta)) mg/dL na 5 minut")
            }
        }
        // Spans the digits' height: the circle at their top, the change just above their baseline.
        .padding(.top, 2)
    }
}

/// The trend arrow in its translucent circle; while a pull's refresh runs the arrow gives way to an arc spinning along
/// the circle's edge and comes back when the data are in. Observes only the refresh, so a drag frame never re-renders it.
private struct TrendBadge: View {
    let direction: String?
    let level: DashboardLevel
    @ObservedObject var activity: PullActivity
    /// The refresh after a return (stale-ui.v1): the same arc as a pull's.
    var refreshing = false
    /// A stale glucose: the circle and arrow dimmed with the value (the spinner stays plain, it is the news).
    var dimmed = false

    var body: some View {
        let spins = activity.refreshing || refreshing
        let tint = dimmed ? Color.secondary : (level == .normal ? Color.primary : DashboardPalette.color(level))
        let showsCircle = direction != nil || spins
        ZStack {
            if showsCircle {
                Circle()
                    .fill(level == .normal || dimmed ? DashboardPalette.chipBackground : DashboardPalette.color(level).opacity(0.18))
                    .transition(.opacity)
            }
            if spins {
                // The arc runs along the circle's own edge.
                SpinningArc(lineWidth: 3, color: dimmed ? Brand.interactive : tint, length: 0.32)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel("Odświeżam")
            } else if let direction {
                TrendArrow(direction: direction)
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(tint)
                    .staleDimmed(dimmed)
                    .transition(.scale(scale: 0.4).combined(with: .opacity))
            }
        }
        // The slot stays when there is no trend, so the change below never moves.
        .frame(width: 40, height: 40)
        .animation(.snappy(duration: 0.3), value: spins)
    }
}

/// Nightscout directions as arrows; the double ones as two arrows side by side.
struct TrendArrow: View {
    let direction: String?

    var body: some View {
        Group {
            switch direction {
            case "DoubleUp": double("arrow.up")
            case "SingleUp": arrow("arrow.up")
            case "FortyFiveUp": arrow("arrow.up.right")
            case "Flat": arrow("arrow.right")
            case "FortyFiveDown": arrow("arrow.down.right")
            case "SingleDown": arrow("arrow.down")
            case "DoubleDown": double("arrow.down")
            default: EmptyView()
            }
        }
        .font(.system(size: 18, weight: .bold))
        .accessibilityLabel(Self.label(direction))
    }

    private func arrow(_ name: String) -> some View {
        Image(systemName: name)
    }

    private func double(_ name: String) -> some View {
        HStack(spacing: -6) {
            Image(systemName: name)
            Image(systemName: name)
        }
    }

    static func isKnown(_ direction: String?) -> Bool {
        GlucoseTrend.isKnown(direction)
    }

    static func label(_ direction: String?) -> String {
        GlucoseTrend.label(direction) ?? ""
    }
}

// MARK: - Bottom row

/// Time in range as a ring marked "TIR" with the percentage; the time below range in red instead of the caption when
/// it is too high. Opens the five-band breakdown.
private struct TimeInRangeTile: View {
    let tir: DashboardTimeInRange?
    /// The five bands from the same readings; the percentages here match the breakdown's.
    let bands: [DashboardGlance.RangeBand]?
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                if let tir {
                    let inRange = bands?.first { $0.kind == .inRange }?.percent ?? tir.in_range_percent
                    let below = bands.map { $0.filter { $0.kind == .low || $0.kind == .veryLow }.map(\.percent).reduce(0, +) } ?? tir.low_percent
                    let level = DashboardThresholds.timeInRange(percent: inRange)
                    let belowLevel = DashboardThresholds.timeBelowRange(percent: below)
                    ZStack {
                        Circle().stroke(DashboardPalette.chipBackground, lineWidth: 5)
                        Circle()
                            .trim(from: 0, to: CGFloat(inRange) / 100)
                            .stroke(level == .normal ? DashboardPalette.green : DashboardPalette.color(level), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text("TIR")
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 38, height: 38)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(inRange)%")
                            .font(.system(size: 19, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(level == .normal ? Color.primary : DashboardPalette.color(level))
                        Group {
                            if belowLevel == .alarm {
                                Text("▼ \(below)% poniżej").foregroundStyle(DashboardPalette.red).fontWeight(.semibold)
                            } else {
                                Text("w zakresie · \(tir.hours) h").foregroundStyle(.secondary)
                            }
                        }
                        .font(.caption)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    }
                } else {
                    Text("Zakres: brak danych").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .glanceTile()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Pokazuje czas w pięciu zakresach")
    }
}

/// The time-in-range breakdown: a stacked column (very high on top, very low at the bottom, as on an AGP report) next
/// to the five bands with their share, time a day and the consensus target. 24 h comes from the dashboard's own
/// readings (as on the tile); 7 and 14 days from the server, loaded when picked and kept while the sheet is open.
private struct TimeInRangeSheet: View {
    let dayBands: [DashboardGlance.RangeBand]?
    let dayCoverage: Int
    let load: (_ days: Int) async throws -> DashboardTimeInRangePeriod

    private enum PeriodState {
        case loading
        case loaded(bands: [DashboardGlance.RangeBand]?, coverage: Int)
        case failed
    }

    @State private var period: DashboardGlance.RangePeriod = .day
    @State private var states: [DashboardGlance.RangePeriod: PeriodState] = [:]
    /// The period picked before: its breakdown stays (dimmed) while the new one loads, so the sheet does not jump.
    @State private var previous: DashboardGlance.RangePeriod = .day
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Okres", selection: $period) {
                    ForEach(DashboardGlance.RangePeriod.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 20)
                .padding(.top, 8)
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .navigationTitle("Czas w zakresie")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        // All five bands at once.
        .presentationDetents([.large])
        .onChange(of: period) { old, _ in
            if case .loaded = state(old) { previous = old }
        }
        .task(id: "\(period.rawValue)-\(attempt)") {
            await loadIfNeeded(period)
        }
    }

    private func state(_ period: DashboardGlance.RangePeriod) -> PeriodState {
        if period == .day { return .loaded(bands: dayBands, coverage: dayCoverage) }
        return states[period] ?? .loading
    }

    @ViewBuilder
    private var content: some View {
        switch state(period) {
        case let .loaded(bands, coverage):
            if let bands {
                breakdown(bands, coverage: coverage, period: period)
            } else {
                ContentUnavailableView("Brak odczytów", systemImage: "chart.bar", description: Text("Nie ma odczytów z okresu: \(period.caption)."))
            }
        case .loading:
            if case let .loaded(bands?, coverage) = state(previous) {
                breakdown(bands, coverage: coverage, period: period)
                    .opacity(0.35)
                    .overlay { ProgressView().controlSize(.large) }
                    .allowsHitTesting(false)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .failed:
            ContentUnavailableView {
                Label("Nie udało się wczytać", systemImage: "wifi.exclamationmark")
            } description: {
                Text("Czas w zakresie z okresu: \(period.caption).")
            } actions: {
                Button("Spróbuj ponownie") {
                    states[period] = nil
                    attempt += 1
                }
            }
        }
    }

    private func loadIfNeeded(_ period: DashboardGlance.RangePeriod) async {
        guard period != .day else { return }
        switch states[period] {
        case .loaded?, .failed?: return
        default: break
        }
        states[period] = .loading
        do {
            let response = try await load(period.days)
            states[period] = .loaded(bands: DashboardGlance.rangeBands(response), coverage: response.sensor_coverage_percent)
        } catch {
            // A period switched away from cancels its request; it loads again when picked.
            if Task.isCancelled || (error as? URLError)?.code == .cancelled {
                states[period] = nil
            } else {
                states[period] = .failed
            }
        }
    }

    private func breakdown(_ bands: [DashboardGlance.RangeBand], coverage: Int, period: DashboardGlance.RangePeriod) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                let inRange = bands.first { $0.kind == .inRange }?.percent ?? 0
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(inRange)% w zakresie")
                        .font(.title.weight(.bold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    Text(period == .day ? "\(period.caption) · mg/dL" : "\(period.caption) · czas średnio na dobę · mg/dL")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    // The consensus asks for at least 70% of the period from the sensor before the numbers are read.
                    Text("dane z sensora: \(coverage)% czasu")
                        .font(.footnote)
                        .foregroundStyle(coverage < 70 ? DashboardPalette.yellow : Color.secondary)
                        .monospacedDigit()
                }
                // The column is as tall as the five rows next to it.
                HStack(alignment: .top, spacing: 16) {
                    column(bands)
                        .frame(maxHeight: .infinity)
                    VStack(spacing: 0) {
                        ForEach(bands) { band in
                            row(band)
                            if band.kind != .veryLow { Divider() }
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .animation(.snappy, value: bands)
    }

    private func column(_ bands: [DashboardGlance.RangeBand]) -> some View {
        GeometryReader { geometry in
            VStack(spacing: 2) {
                ForEach(bands) { band in
                    if band.percent > 0 {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(Self.color(band.kind))
                            .frame(height: max(4, (geometry.size.height - 8) * CGFloat(band.percent) / 100))
                    }
                }
            }
        }
        .frame(width: 26)
        .padding(.vertical, 9)
        .accessibilityHidden(true)
    }

    private func row(_ band: DashboardGlance.RangeBand) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            RoundedRectangle(cornerRadius: 3).fill(Self.color(band.kind)).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(band.title).font(.subheadline.weight(.semibold))
                Text(band.range).font(.caption).foregroundStyle(.secondary)
                if let met = band.targetMet {
                    Label(band.target, systemImage: met ? "checkmark" : "exclamationmark.triangle.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2)
                        .foregroundStyle(met ? Color.secondary : DashboardPalette.color(band.kind == .inRange || band.kind == .high ? .warning : .alarm))
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(band.percent)%")
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                Text(DashboardGlance.duration(minutes: band.minutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }

    /// AGP colours: very high orange, high yellow, in range the brand's emerald, low red, very low dark red.
    static func color(_ kind: DashboardGlance.RangeBand.Kind) -> Color {
        switch kind {
        case .veryHigh: return Brand.dynamic(light: 0xE8590C, dark: 0xFF8A3D)
        case .high: return DashboardPalette.yellow
        case .inRange: return DashboardPalette.green
        case .low: return DashboardPalette.red
        case .veryLow: return Brand.dynamic(light: 0x9F1D17, dark: 0xC9302A)
        }
    }
}

/// "Sprzęt OK", or the item needing attention most (in its colour) with a count of the others; opens the full list.
private struct EquipmentTile: View {
    let attention: [DashboardGlance.EquipmentItem]
    let hasData: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                icon
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(worst == .normal ? Color.primary : DashboardPalette.color(worst))
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }
            .glanceTile()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Pokazuje cały sprzęt")
    }

    private var worst: DashboardLevel { attention.first?.level ?? .normal }

    private var title: String {
        guard let first = attention.first else { return hasData ? "Sprzęt OK" : "Sprzęt" }
        return first.headline
    }

    private var subtitle: String {
        switch attention.count {
        case 0: return hasData ? "nic do wymiany" : "brak danych"
        case 1: return attention[0].hint ?? ""
        case 2: return "+ \(attention[1].headline.lowercased())"
        default: return "+ \(attention.count - 1) inne"
        }
    }

    private var icon: some View {
        let color = worst == .normal ? Brand.rescue : DashboardPalette.color(worst)
        return RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(color.opacity(0.16))
            .frame(width: 36, height: 36)
            .overlay {
                if attention.isEmpty {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 17)).foregroundStyle(color)
                } else {
                    Image(systemName: "exclamationmark").font(.system(size: 17, weight: .heavy)).foregroundStyle(color)
                }
            }
            .overlay(alignment: .topTrailing) {
                if attention.count > 1 {
                    Text("\(attention.count)")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(.white)
                        .monospacedDigit()
                        // A circle for one digit; only a two-digit count stretches it.
                        .padding(.horizontal, 3)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Capsule().fill(color))
                        .overlay(Capsule().stroke(DashboardPalette.cardBackground, lineWidth: 2))
                        .offset(x: 6, y: -6)
                }
            }
    }
}

/// An icon in a soft square of its colour, a title and a caption: the loop and last-bolus tiles.
private struct InfoTile: View {
    let symbol: String
    let tint: Color
    let title: String
    var titleColor: Color = .primary
    let caption: String

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(tint.opacity(0.16))
                .frame(width: 36, height: 36)
                .overlay {
                    Image(systemName: symbol).font(.system(size: 16, weight: .bold)).foregroundStyle(tint)
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(titleColor)
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
        }
        .glanceTile()
        .accessibilityElement(children: .combine)
    }
}

/// Whether the loop is running: when it last calculated and the basal rate now; yellow or red when it stopped.
private struct LoopTile: View {
    let loop: DashboardGlance.LoopStatus?
    @Environment(\.loopSystem) private var loopSystem

    var body: some View {
        if let loop {
            if loop.level == .normal {
                InfoTile(symbol: "arrow.triangle.2.circlepath", tint: Brand.interactive, title: "Pętla działa", caption: caption(loop))
            } else {
                InfoTile(symbol: "exclamationmark", tint: DashboardPalette.color(loop.level), title: "Pętla \(loop.minutes) min",
                         titleColor: DashboardPalette.color(loop.level), caption: "sprawdź \(loopSystem.names.accusative)")
            }
        } else {
            InfoTile(symbol: "arrow.triangle.2.circlepath", tint: .secondary, title: "Pętla", caption: "brak danych")
        }
    }

    private func caption(_ loop: DashboardGlance.LoopStatus) -> String {
        let age = DashboardGlance.ago(minutes: loop.minutes)
        guard let rate = loop.basalRate else { return age }
        return "\(age) · \(DashboardFormat.dose(rate)) j/h"
    }
}

/// The newest bolus of the last 24 h: units, time and how long ago.
private struct LastBolusTile: View {
    let bolus: DashboardGlance.LastBolus?
    let now: Date

    /// The chart's bolus blue, so the tile matches the triangles.
    private static let insulin = Color(red: 0.039, green: 0.424, blue: 1.0)

    var body: some View {
        if let bolus {
            let minutes = DashboardFormat.wholeMinutes(since: bolus.at, now: now)
            InfoTile(symbol: "syringe.fill", tint: Self.insulin, title: "Bolus \(DashboardFormat.dose(bolus.units)) j",
                     caption: "o \(RemoteCommandFormat.time(bolus.at)) · \(DashboardGlance.ago(minutes: minutes))")
        } else {
            InfoTile(symbol: "syringe", tint: .secondary, title: "Bez bolusa", caption: "w ciągu 24 h")
        }
    }
}

private extension View {
    /// The bottom row's card: same height and padding for both tiles.
    func glanceTile() -> some View {
        padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(DashboardPalette.cardBackground))
    }
}

/// Everything about the pump, sensor and site: what needs attention first (with what to do), the rest after it.
private struct EquipmentSheet: View {
    let items: [DashboardGlance.EquipmentItem]

    var body: some View {
        let attention = DashboardGlance.attention(items)
        let fine = items.filter { $0.level == .normal }
        NavigationStack {
            List {
                if !attention.isEmpty {
                    Section("Wymaga uwagi") {
                        ForEach(attention) { row($0) }
                    }
                }
                if !fine.isEmpty {
                    Section("W porządku") {
                        ForEach(fine) { row($0) }
                    }
                }
                if items.isEmpty {
                    Text("Brak danych o sprzęcie z Nightscout.").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Sprzęt")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ item: DashboardGlance.EquipmentItem) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(item.level == .normal ? Brand.rescue : DashboardPalette.color(item.level))
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.body.weight(.semibold))
                Text(item.hint ?? item.note).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 5) {
                Text(item.value)
                    .font(.body.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(item.level == .normal ? Color.primary : DashboardPalette.color(item.level))
                if let fraction = item.fraction {
                    Meter(fraction: fraction, level: item.level)
                        .frame(width: 80)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct Meter: View {
    let fraction: Double
    let level: DashboardLevel

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(DashboardPalette.chipBackground)
                Capsule()
                    .fill(level == .normal ? DashboardPalette.green : DashboardPalette.color(level))
                    .frame(width: geometry.size.width * min(max(fraction, 0.02), 1))
            }
        }
        .frame(height: 3)
    }
}

// MARK: - Style

enum DashboardPalette {
    /// In range: the brand's emerald (Brand.inRange) instead of the system's bright green, which clashed with the petrol.
    static let green = Brand.inRange
    /// Darker than system yellow, so yellow numbers stay readable on a white card.
    static let yellow = Color(red: 0.878, green: 0.631, blue: 0.0)
    static let red = Color(red: 1.0, green: 0.231, blue: 0.188)
    /// Insulin, as the chart's bolus marks.
    static let insulin = Color(red: 0.039, green: 0.424, blue: 1.0)

    #if canImport(UIKit)
    /// The tile panel: just off the page (barely lighter than black in dark mode), so it reads as one quiet surface.
    static let panelBackground = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.075, alpha: 1) : .secondarySystemGroupedBackground })
    static let panelHairline = Color(uiColor: .separator)
    static let pageBackground = Color(uiColor: .systemGroupedBackground)
    static let cardBackground = Color(uiColor: .secondarySystemGroupedBackground)
    static let chipBackground = Color(uiColor: .tertiarySystemFill)
    #else
    static let panelBackground = Color(nsColor: .controlBackgroundColor)
    static let panelHairline = Color(nsColor: .separatorColor)
    static let pageBackground = Color(nsColor: .windowBackgroundColor)
    static let cardBackground = Color(nsColor: .controlBackgroundColor)
    static let chipBackground = Color.secondary.opacity(0.12)
    #endif

    static func color(_ level: DashboardLevel) -> Color {
        switch level {
        case .normal: return .primary
        case .warning: return yellow
        case .alarm: return red
        }
    }

    /// Glucose in range is green, not the neutral text colour of the other values.
    static func glucose(_ level: DashboardLevel) -> Color {
        level == .normal ? green : color(level)
    }

}
