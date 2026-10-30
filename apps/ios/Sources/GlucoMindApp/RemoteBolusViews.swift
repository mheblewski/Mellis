import Charts
import SwiftUI
import GlucoMindCore

/// The Bolus tab (remote-bolus-trio-plan.md W3, D2; layout A of the 2026-10-23 redesign): the glucose in one row like
/// the dashboard's, the forecast card (2 hours back, 3 ahead, with and without the dose, bolus-forecast.v1), the carbs
/// and insulin fields, and a slider pinned at the bottom that sends at once (Face ID follows).
///
/// After the slide the form is locked and the slider becomes a loader with the steps (sent, Trio accepted, given) until
/// Trio's final answer. Only then does the form change: cleared when given, kept when refused or unanswered, and only
/// the carbs cleared when Trio stored them but refused the bolus. Trio's long messages are shortened (TrioReplyText),
/// the full text under "Szczegóły z Trio".
/// What the Bolus tab's tour needs from the app (AppContainer): whose "seen" mark it is, whether anything else is on
/// screen, and the requests to open it (Ustawienia → "Przewodnik po ekranie Bolus").
struct BolusTourHost {
    /// SetupGuideKey.make(server, user id); nil while the person is not known (no tour by itself then).
    var key: () -> String? = { nil }
    /// "Przewodnik konfiguracji" is on screen or about to open.
    var setupGuideShowing: () -> Bool = { false }
    /// One of the app's sheets is up (Ustawienia, notifications, a handed-over setting, …).
    var modalShowing: () -> Bool = { false }
    /// Grows with each request from Ustawienia.
    var request: Int = 0
    /// The tour may open by itself (not in fixtures and simulator walkthroughs, which keep their screens).
    var autoStartAllowed: Bool = false
    /// The app's tour, drawn at its root over the bars (SpotlightRootOverlay).
    var controller: SpotlightTourController
}

struct RemoteBolusTabView: View {
    /// The loop the commands go to, by name (Trio, Loop).
    @Environment(\.loopSystem) private var loopSystem
    private var loop: LoopSystemNames { loopSystem.names }
    @StateObject private var viewModel: RemoteBolusViewModel
    @Environment(\.liveUpdates) private var liveUpdates
    let trailingControls: AnyView
    let canChangePatient: Bool
    let onShowPatientSelection: () -> Void
    /// "Zapytaj w czacie": a new, empty conversation (nil: no chat to open).
    let onAskInChat: (() -> Void)?
    let onOpenMeal: (String) -> Void
    /// The Bolus tour (BolusTour): whose "seen" mark, what else is on screen, and the requests from Ustawienia.
    let tourHost: BolusTourHost

    private enum Field: Hashable { case carbs, insulin }
    private enum Segment: Hashable { case give, history }
    @State private var segment: Segment = .give
    /// "Przypomnij": the sheet with the WBT and second-dose reminders.
    @State private var showsReminders = false
    /// The field typed in when "Przypomnij" was tapped: the screen keeps its typing layout behind the sheet (the keyboard
    /// going down must not resize the chart and the fields), and the field gets the keyboard back when it closes.
    @State private var focusBeforeReminders: Field?
    /// The system number pad (digits for carbs, decimal for insulin) on the amount being typed.
    @FocusState private var focused: Field?
    /// The chart made smaller while a field is typed in: set in one animation for the whole screen, so the chart, the
    /// tiles and the hints move together (each with its own animation they drifted apart).
    @State private var compact = false
    /// The chart's height while typing: whatever is left between the glucose and the hints above the slider, measured on
    /// this phone with its keyboard (a fixed height left either a gap or the hints under the slider, depending on the phone).
    @State private var compactChartHeight: CGFloat = 72
    /// Where the scroll view starts and the slider's bar (above the keyboard) starts, on screen, and the content's height.
    /// Measured as positions: the scroll view's safe area insets did not say reliably how much the bar and the keyboard cover.
    @State private var scrollTop: CGFloat = 0
    @State private var barTop: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    /// While typing, the height left over once the chart is at its tallest: the two fields grow by it (their footers,
    /// the reminder and the ICR formula, sit at their bottom), so no empty band stays between them and the slider.
    @State private var fieldsExtraHeight: CGFloat = 0
    /// The chart and the fields are animating to a fitted height (see fitCompactChart).
    @State private var fitAnimating = false
    /// The checks' row shows every item (a tap on it).
    @State private var checksExpanded = Self.fixtureChecksExpanded

    /// GLUCOMIND_UI_FIXTURES_CHECKS_EXPANDED=1 (Debug, UI fixtures): the checks' list open (screenshots).
    private static var fixtureChecksExpanded: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES"] == "1" && ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_CHECKS_EXPANDED"] == "1"
        #else
        false
        #endif
    }
    /// DANGER warnings to confirm before the slide sends (their row is short now, so the slide says them in full).
    @State private var pendingDangerConfirmation: [BolusCheckItem]?
    /// The spotlight tour (drawn at the app's root, over the bars: nothing here moves when it starts). The slider is
    /// off for as long as it is on.
    @ObservedObject private var tourController: SpotlightTourController
    private var tour: SpotlightTour? {
        get { tourController.tour }
        nonmutating set { tourController.tour = newValue }
    }
    /// Whose tour it is (nil: a fixture's, which marks nothing).
    @State private var tourKey: String?
    private static let tourStore = UserDefaultsSpotlightTourSeenStore()
    /// Never taller than without the keyboard (190): the chart only gives way, it does not grow.
    private static let compactChartRange: ClosedRange<CGFloat> = 44...190

    init(
        viewModel: @autoclosure @escaping () -> RemoteBolusViewModel,
        trailingControls: AnyView,
        canChangePatient: Bool = false,
        onShowPatientSelection: @escaping () -> Void = {},
        onAskInChat: (() -> Void)? = nil,
        onOpenMeal: @escaping (String) -> Void,
        tourHost: BolusTourHost
    ) {
        self.onAskInChat = onAskInChat
        self.tourHost = tourHost
        _tourController = ObservedObject(wrappedValue: tourHost.controller)
        _viewModel = StateObject(wrappedValue: viewModel())
        self.trailingControls = trailingControls
        self.canChangePatient = canChangePatient
        self.onShowPatientSelection = onShowPatientSelection
        self.onOpenMeal = onOpenMeal
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // While typing the switch and the top bar make way for the chart: nothing else moves, they come back
                // with the keyboard going down.
                if !compact {
                    HStack(spacing: 10) {
                        Picker("Widok", selection: $segment) {
                            Text("Podaj").tag(Segment.give)
                            Text("Historia").tag(Segment.history)
                        }
                        .pickerStyle(.segmented)
                        .tourAnchor(.modeSwitch)
                        // The tour again, small and quiet beside the switch.
                        Button { requestTour() } label: {
                            Image(systemName: "questionmark.circle")
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 44, minHeight: 32)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Przewodnik po ekranie Bolus")
                        .accessibilityIdentifier("bolus.tour.open")
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 6)
                    .padding(.top, 4)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                if segment == .give {
                    giveView
                } else {
                    historyView
                }
            }
                // VoiceOver keeps to the tour's callout while it is on.
                .accessibilityHidden(tour?.isActive == true)
                .background(DashboardPalette.pageBackground)
                .onChange(of: tourStage.isSample, initial: true) { _, sample in tourController.sampleStep = sample }
                // "Przypomnij" presents from here, not from its chip: the chip is drawn in each of the hints' layouts
                // (ViewThatFits), and a layout switch while the sheet is open (the keyboard going down) dismissed it.
                .sheet(isPresented: $showsReminders, onDismiss: {
                    // Back to typing where it was; without a field typed in, the usual layout comes back.
                    if let field = focusBeforeReminders {
                        focused = field
                    } else if self.compact {
                        withAnimation(.snappy(duration: 0.3)) { self.compact = false }
                    }
                    focusBeforeReminders = nil
                }) {
                    BolusReminderSheet(plan: $viewModel.reminderPlan, glucoseRisingNow: viewModel.glucoseRisingNow)
                        .presentationDetents([.medium, .large])
                }
                // No title: the hummingbird with the patient (top left) and the controls (top right), as on the dashboard.
                .navigationTitle("")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(compact ? .hidden : .automatic, for: .navigationBar)
                #endif
                .toolbar {
                    #if os(iOS)
                    if let patientName = viewModel.flow.patientName {
                        BubblelessToolbarItem(placement: .topBarLeading) {
                            PatientTitle(name: patientName, canChangePatient: canChangePatient, onShowPatientSelection: onShowPatientSelection)
                        }
                    }
                    #endif
                    ToolbarItem(placement: .primaryAction) { trailingControls }
                }
                .task {
                    viewModel.bindLiveUpdates(liveUpdates)
                    await viewModel.load()
                    #if DEBUG
                    // Visual checks with fixtures: the grams typed and the keyboard up (see GLUCOMIND_UI_FIXTURES_BOLUS).
                    if let grams = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_BOLUS"], ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES"] == "1" {
                        viewModel.carbsText = grams
                        viewModel.mealLater = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_MEAL_LATER"] == "1"
                        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_REMINDERS"] == "1" {
                            viewModel.reminderPlan = BolusReminderPlan(wbt: true, secondDose: .whenRising)
                        }
                        if let insulin = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_INSULIN"] {
                            await viewModel.refreshPreview()
                            viewModel.insulinText = insulin
                        }
                        // GLUCOMIND_UI_FIXTURES_DOSE_SOURCE=icr: the corner calculator switched off (carbs / ICR over the calculator);
                        // =higher: the opt-in correction switched on (dose-calculator.v2, with GLUCOMIND_UI_FIXTURES_DOSE=high).
                        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_DOSE_SOURCE"] == "icr" {
                            await viewModel.refreshPreview()
                            viewModel.useDoseSource(.icr)
                        }
                        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_DOSE_SOURCE"] == "higher" {
                            await viewModel.refreshPreview()
                            viewModel.useDoseSource(.higher)
                        }
                        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_KEYBOARD"] == "1" {
                            // After the strip has settled from its loader, or the focus is lost in the change.
                            try? await Task.sleep(nanoseconds: 700_000_000)
                            focused = .carbs
                        }
                    }
                    #endif
                    // Glucose and IOB move on: the checks behind the slider and the chart are read again every minute.
                    // Leaving the tab cancels the wait: nothing is read then (a cancelled read used to wipe the readings and
                    // flash "Nie udało się wczytać…" when coming back).
                    while !Task.isCancelled {
                        do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { break }
                        await viewModel.refreshPreview()
                        await viewModel.refreshReadings()
                    }
                }
                // Once per person on this phone: when the tab is first opened, as soon as nothing else is on screen.
                .task { await autoStartTour() }
                .onChange(of: tourHost.request) { _, _ in requestTour(after: 700_000_000) }
                // A command on its way (from another phone, a notification's action) ends the tour.
                .onChange(of: viewModel.isLocked) { _, locked in if locked { interruptTour() } }
                .onDisappear { interruptTour() }
        }
    }

    // MARK: Przewodnik

    /// What the tab draws as a sample for the current step (the alarm clock, the switch, the warnings row).
    private var tourStage: BolusTourStage {
        BolusTour.stage(tour: tour, realRemindersShown: showsReminderBell, realDoseSourceShown: viewModel.doseSwitch != nil, realChecksShown: !checkSummary.isEmpty)
    }

    private var tourConditions: BolusTour.StartConditions {
        BolusTour.StartConditions(
            setupGuideShowing: tourHost.setupGuideShowing(),
            modalShowing: tourHost.modalShowing() || showsReminders || pendingDangerConfirmation != nil || viewModel.pendingLowGlucoseConfirmation,
            keyboardVisible: focused != nil || compact,
            sendInFlight: viewModel.isLocked || viewModel.flow.state == .sending || viewModel.flow.state == .checking || viewModel.waitingUntil != nil,
            onGiveSegment: segment == .give,
            loaded: !viewModel.chartIsLoading
        )
    }

    private func autoStartTour() async {
        #if DEBUG
        // GLUCOMIND_UI_FIXTURES_BOLUS_TOUR=1…8 (or a step's name): the tour at that step, whatever was seen (screenshots).
        if let fixture = Self.fixtureTourStep {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled, tour == nil else { return }
            startTour(at: fixture)
            return
        }
        #endif
        guard tourHost.autoStartAllowed else { return }
        // Settled for two checks in a row (a sheet closing, the first data arriving), checked for a minute at most.
        var settled = 0
        for _ in 0..<120 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, tour == nil else { return }
            let key = tourHost.key()
            guard SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: key, store: Self.tourStore) else {
                // Not known yet who is signed in: wait; seen: never again by itself.
                if key != nil { return }
                continue
            }
            settled = tourConditions.allowsAutoStart ? settled + 1 : 0
            if settled >= 2 {
                startTour(at: nil)
                return
            }
        }
    }

    /// The "?" button and Ustawienia: the keyboard goes down and "Podaj" shows, then the tour once nothing else is up.
    private func requestTour(after delay: UInt64 = 0) {
        focused = nil
        segment = .give
        Task { @MainActor in
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            for _ in 0..<20 {
                // The keyboard going down and the layout coming back first.
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard tour == nil else { return }
                if tourConditions.allowsRequestedStart && !compact {
                    startTour(at: nil)
                    return
                }
            }
        }
    }

    private func startTour(at step: BolusTourStep?) {
        focused = nil
        segment = .give
        var key = tourHost.key()
        #if DEBUG
        if Self.fixtureTourStep != nil { key = nil }
        #endif
        // Marked seen only by "Gotowe" or "Pomiń" (endTour); a fixture tour changes no mark.
        tourKey = key
        tourController.isAvailable = { _ in true }
        tourController.onEnd = { outcome in endTour(outcome) }
        withAnimation(.easeInOut(duration: 0.25)) { tour = BolusTour.start(at: step) }
    }

    private func endTour(_ outcome: SpotlightTour.Outcome) {
        SpotlightTourSeen.noteEnded(outcome, tourID: BolusTour.id, key: tourKey, store: Self.tourStore)
        withAnimation(.easeInOut(duration: 0.25)) { tour = nil }
    }

    private func interruptTour() {
        guard tour != nil else { return }
        tour?.interrupt()
        tour = nil
    }

    #if DEBUG
    private static var fixtureTourStep: BolusTourStep? {
        guard ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES"] == "1",
              let value = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_BOLUS_TOUR"] else { return nil }
        return BolusTourStep.fixture(value)
    }
    #endif

    // MARK: Podaj

    /// The card under the fields: the steps while Trio works, else Trio's answer (nil: the usual hints).
    private var showsOutcome: Bool {
        viewModel.isLocked || viewModel.outcome != nil
    }

    private var giveView: some View {
        ScrollViewReader { scroll in
        ScrollView {
            // Tighter while typing: the hints under the fields must stay above the slider and the keyboard.
            VStack(alignment: .leading, spacing: compact ? 8 : 12) {
                if let error = viewModel.previewError {
                    Label(error, systemImage: "wifi.exclamationmark").font(.footnote).foregroundStyle(.red)
                }
                // A retry started from the history (Trio's own answer on this screen has its card below instead).
                if let retry = viewModel.retry, viewModel.outcome == nil, !viewModel.isLocked {
                    retryBanner(retry)
                }

                // While typing the glucose, IOB and COB go into the chart's header (one short line).
                if !compact {
                    TimelineView(.periodic(from: .now, by: 15)) { context in
                        BolusGlucoseRow(context: viewModel.preview?.context, loading: viewModel.chartIsLoading, now: context.date)
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.8, anchor: .topLeading)))
                }
                BolusForecastCard(
                    readings: viewModel.readings,
                    forecast: viewModel.preview?.forecast,
                    hasGlucose: viewModel.preview?.context.glucose != nil,
                    updating: viewModel.chartIsUpdating,
                    loading: viewModel.chartIsLoading,
                    compact: compact,
                    compactChartHeight: compactChartHeight,
                    context: viewModel.preview?.context
                )
                .tourAnchor(.forecast)
                .id(BolusTourStep.forecast.rawValue)

                // The fields side by side, field-like (fill, outline, focus ring): with the keyboard up the chart stays in view.
                // Both the same height (the taller one's, plus what is left over while typing): their footers line up.
                HStack(spacing: 10) {
                    amountField(.carbs, label: "Węglowodany", icon: "fork.knife", text: $viewModel.carbsText, unit: "g", tint: .orange, inTrio: carbsInTrio) {
                        if !showsOutcome { carbsFooter }
                    }
                    .tourAnchor(.carbs)
                    amountField(.insulin, label: "Insulina", icon: "drop.fill", text: $viewModel.insulinText, unit: "j", tint: .accentColor, inTrio: nil) {
                        if !showsOutcome { insulinFooter }
                    }
                    .tourAnchor(.insulin)
                }
                .fixedSize(horizontal: false, vertical: true)
                .id("bolus.tour.fields")

                if showsOutcome {
                    outcomeCard
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                } else if (viewModel.carbsG ?? 0) == 0 && (viewModel.insulinU ?? 0) == 0 {
                    Text("Wpisz węglowodany: insulinę policzę z ICR.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                }
                // The check of what the slider would send now: also under Trio's answer, as the slider is live again.
                if !viewModel.isLocked {
                    checks
                }
                Color.clear.frame(height: 0).id(Self.contentEndID)
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, compact ? 6 : 12)
            .animation(.snappy(duration: 0.3), value: outcomeKey)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                contentHeight = height
                fitCompactChart()
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { top in
            scrollTop = top
            fitCompactChart()
        }
        .scrollDismissesKeyboard(.interactively)
        // No keyboard toolbar ("Gotowe"): iOS counted it into the keyboard's height differently for the number pad and
        // the decimal pad, so the slider sat higher for the insulin than for the carbs. The bar's own button hides it.
        .onChange(of: focused) { _, field in
            guard !showsReminders, (field != nil) != compact else { return }
            withAnimation(.snappy(duration: 0.3)) { compact = field != nil }
        }
        .onChange(of: compact) { _, compact in
            if !compact && fieldsExtraHeight != 0 {
                withAnimation(.snappy(duration: 0.3)) { fieldsExtraHeight = 0 }
            }
        }
        // Where the screen is too short for everything above the keyboard (a larger text size, a taller keyboard), the
        // hints are scrolled into view once the keyboard is up; the glucose goes under the top bar then.
        .task(id: compact) {
            guard compact else { return }
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            // The end of the content, not the hints: the warnings under them must not stay under the slider.
            withAnimation(.snappy(duration: 0.3)) { scroll.scrollTo(Self.contentEndID, anchor: .bottom) }
        }
        .onChange(of: viewModel.isLocked) { _, locked in
            if locked { focused = nil }
        }
        // The tour's element in view: the chart and the fields are in the scroll view (the slider is pinned below).
        .onChange(of: tour?.current?.id) { _, id in
            guard let id, let step = BolusTourStep(rawValue: id) else { return }
            let target: String
            switch step {
            case .modeSwitch, .forecast: target = BolusTourStep.forecast.rawValue
            case .carbs, .reminders, .insulin, .doseSource: target = "bolus.tour.fields"
            case .checks: target = BolusTourStep.checks.rawValue
            case .slider: target = Self.contentEndID
            }
            withAnimation(.snappy(duration: 0.35)) { scroll.scrollTo(target, anchor: step == .modeSwitch || step == .forecast ? .top : .center) }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                // The last row above the slider, the same with or without warnings and the keyboard (lower while typing:
                // the chart gives way, the warnings above stay in view).
                // With carbs typed the row asks whether the dose is a meal; the chat stays as its round button.
                if !viewModel.isLocked, viewModel.retry == nil, (viewModel.carbsG ?? 0) > 0 {
                    SaveAsMealRow(
                        isOn: $viewModel.saveAsMeal,
                        locked: viewModel.saveAsMealLocked,
                        compact: compact,
                        onAskInChat: onAskInChat
                    )
                    .transition(.opacity)
                } else if let onAskInChat, !viewModel.isLocked {
                    AskInChatRow(compact: compact, action: onAskInChat)
                        .transition(.opacity)
                }
                if !viewModel.flow.bolusAcknowledged, !viewModel.isLocked {
                    // Once per phone: the slider stays off until the DIY acknowledgement is accepted.
                    DIYBolusAcknowledgementRow(acknowledged: false) { viewModel.flow.acceptBolusAcknowledgement() }
                        .transition(.opacity)
                }
                if let notice = viewModel.slideNotice {
                    Label(notice, systemImage: "arrow.clockwise").font(.footnote).foregroundStyle(.orange)
                }
                if case let .failed(message) = viewModel.flow.state, viewModel.outcome == nil {
                    // Nothing left the phone (Face ID, limits, the server): the amounts stay.
                    Label(TrioReplyText(statusMessage: message).short, systemImage: "xmark.octagon.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let until = viewModel.waitingUntil, !viewModel.isLocked {
                    // Another phone's command waits for Trio's answer: the slider stays off for at most this long.
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Label("Czekam na odpowiedź \(loop.genitive) · jeszcze \(RemoteCommandFormat.clock(until.timeIntervalSince(context.date)))", systemImage: "hourglass")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .task(id: until) {
                        let wait = until.timeIntervalSinceNow
                        if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000) + 500_000_000) }
                        guard !Task.isCancelled else { return }
                        await viewModel.refreshRecent()
                        await viewModel.refreshPreview()
                    }
                }
                if viewModel.isLocked {
                    SlideProgressTrack(title: progressTitle, resolution: settlingResolution)
                        .transition(.opacity)
                } else {
                    HStack(spacing: 10) {
                        // Off for the whole tour, whatever the form says (BolusTour.slideEnabled), but drawn as it was:
                        // nothing on screen changes when the tour starts.
                        SlideToConfirm(title: slideTitle, subtitle: slideSubtitle, isEnabled: BolusTour.slideEnabled(viewModel.canGive && viewModel.waitingUntil == nil, tour: tour), looksEnabled: viewModel.canGive && viewModel.waitingUntil == nil) {
                            slide()
                        }
                        // A new slider after each attempt (sent, refused, data read again): the knob starts at the left again.
                        .id(slideResetKey)
                        if compact {
                            hideKeyboardButton
                                .transition(.scale(scale: 0.6).combined(with: .opacity))
                        }
                    }
                    .lowGlucoseInsulinConfirmation(isPresented: $viewModel.pendingLowGlucoseConfirmation, insulin: viewModel.insulinU) {
                        Task { await viewModel.slideToGive(lowGlucoseConfirmed: true) }
                    }
                    .dangerWarningsConfirmation(pending: $pendingDangerConfirmation, insulin: viewModel.insulinU) {
                        Task { await viewModel.slideToGive() }
                    }
                    .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.25), value: viewModel.isLocked)
            .animation(.snappy(duration: 0.3), value: compact)
            // The slider's step points at the whole bar: "Zapisz jako posiłek" above it is in its text.
            .tourAnchor(.slider)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(.bar)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { top in
                barTop = top
                fitCompactChart()
            }
        }
        }
    }

    private static let contentEndID = "contentEnd"

    /// While typing, the chart takes the height that makes the screen end just above the slider, and what it cannot take
    /// (it never grows past its usual height) goes to the fields.
    /// The heights measured while a change animates are the animation's, not the new layout's: fitted on them, the chart
    /// and the fields chased each other for ever (a layout loop at full CPU). So nothing is fitted until the change has
    /// settled; then once more on the settled heights.
    private func fitCompactChart() {
        let viewportHeight = barTop - scrollTop
        // Behind the reminders sheet the keyboard is down for a moment: the chart keeps its height.
        guard compact, !showsReminders, !fitAnimating, viewportHeight > 0, contentHeight > 0 else { return }
        let available = (compactChartHeight + fieldsExtraHeight + viewportHeight - contentHeight).rounded(.down)
        let fitted = min(Self.compactChartRange.upperBound, max(Self.compactChartRange.lowerBound, available))
        let extra = max(0, available - fitted)
        guard abs(fitted - compactChartHeight) >= 1 || abs(extra - fieldsExtraHeight) >= 1 else { return }
        fitAnimating = true
        withAnimation(.snappy(duration: 0.3)) {
            compactChartHeight = fitted
            fieldsExtraHeight = extra
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            fitAnimating = false
            fitCompactChart()
        }
    }

    /// Hides the number pad, beside the slider (the same height, so the bar never moves).
    private var hideKeyboardButton: some View {
        Button { focused = nil } label: {
            Image(systemName: "keyboard.chevron.compact.down")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 56, height: 56)
                .background(Circle().fill(Color.accentColor.opacity(0.15)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Gotowe")
        .accessibilityHint("Chowa klawiaturę")
    }

    /// The carbs field's footer: "Posiłek za 15 min" (the reminders are the badge in its header).
    @ViewBuilder
    private var carbsFooter: some View {
        if !viewModel.isLocked, (viewModel.carbsG ?? 0) > 0, viewModel.retry?.carbsKept != true {
            mealLaterToggle
                .padding(.top, 8)
        }
    }

    /// The reminder badge in the carbs field's header: reminders hang on the meal the carb entry starts (without carbs there is
    /// none, nor while the command is on its way).
    private var showsReminderBell: Bool {
        !viewModel.isLocked && viewModel.retry == nil && (viewModel.carbsG ?? 0) > 0
    }

    /// The insulin field's footer: where the dose comes from, or the way back to it once the dose was typed over.
    @ViewBuilder
    private var insulinFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            // With the calculator below carbs / ICR the way back is the corner calculator button, not this one.
            if viewModel.insulinEdited, viewModel.doseSourceOffer == nil, let restore = viewModel.defaultDose, viewModel.retry == nil {
                // Back to the dose the form starts from: the calculator's (dose-calculator.v1), else carbs / ICR.
                let calculated = viewModel.preview?.dose_calculation != nil
                Button { viewModel.useICRDose() } label: {
                    Label(calculated ? "Przywróć \(RemoteCommandFormat.units(restore)) j" : "Z ICR: \(RemoteCommandFormat.units(restore)) j", systemImage: "arrow.uturn.backward")
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .font(.footnote.weight(.medium))
                .buttonStyle(.borderless)
                .accessibilityLabel("Przywróć dawkę: \(RemoteCommandFormat.units(restore)) j")
            } else if let icrLine = viewModel.icrLine, viewModel.calculatorLine == nil {
                Text(icrLine)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            // Where the number comes from: "Kalkulator: 1,2 j (IOB 1,1 j, glukoza 95↓)".
            // In a few words (2 lines on a narrow phone); the whole explanation and the formula behind the info button.
            if let line = viewModel.calculatorLine {
                DoseExplanationLine(line: line, details: viewModel.calculatorDetails, lowersDose: viewModel.calculatorLowersDose)
            }
        }
        .padding(.top, 8)
    }

    /// What the check of the amounts on screen says: the forecast going low, this phone's limits, the server's blocks
    /// and warnings, as ONE compact row in the colour of the most serious one (1.0.5): a tap shows them all.
    @ViewBuilder
    private var checks: some View {
        let summary = checkSummary
        if !summary.isEmpty {
            BolusChecksRow(summary: summary, expanded: $checksExpanded)
                .tourAnchor(.checks)
                .id(BolusTourStep.checks.rawValue)
        } else if tourStage.showsSampleChecks {
            // The tour's sample: a picture of the row ("Przykład: …"), only during its step; the form is not touched.
            BolusChecksRow(summary: BolusTour.sampleChecks, expanded: .constant(false))
                .allowsHitTesting(false)
                .tourAnchor(.checks)
                .id(BolusTourStep.checks.rawValue)
                .transition(.opacity)
        }
    }

    /// The checks of the amounts on screen (BolusCheckSummary): the chart's forecast, limits, blocks and warnings.
    private var checkSummary: BolusCheckSummary {
        let forecast = viewModel.previewMatchesScreen ? viewModel.preview?.forecast : nil
        return BolusCheckSummary.make(
            forecastLowAt: forecast?.lowDate,
            forecastLoopGenitive: forecast?.isLoopOnly == true ? loopSystem.names.genitive : nil,
            forecastLowFromDose: forecast.map { $0.low_from_dose && $0.insulin_u > 0 } ?? false,
            totalLowWithoutLine: forecast?.totalLowWithoutLine,
            totalFromDashedLine: forecast?.hasExcessModel == true,
            limitProblem: viewModel.limitProblem,
            blocks: viewModel.visibleBlocks,
            warnings: viewModel.visibleWarnings
        )
    }

    /// The slide: a DANGER warning on screen (only a short row now) is confirmed first, with its full text.
    private func slide() {
        guard tour == nil else { return }
        focused = nil
        let dangers = checkSummary.confirmations
        if dangers.isEmpty {
            Task { await viewModel.slideToGive() }
        } else {
            pendingDangerConfirmation = dangers
        }
    }

    private func retryBanner(_ retry: RemoteBolusRetryTarget) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "arrow.clockwise")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Text(retry.carbsKept ? "Ponowienie: węglowodany są już w \(loop.locative), wyślę samą insulinę." : "Ponowienie odrzuconego polecenia.")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Anuluj") { viewModel.cancelRetry() }.font(.footnote.weight(.medium))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.accentColor.opacity(0.1)))
    }

    /// The steps while the command is on its way, else Trio's answer.
    @ViewBuilder
    private var outcomeCard: some View {
        switch viewModel.outcome {
        case nil, .waiting?:
            let command = viewModel.outcome?.command
            // A meal to Loop goes as two pushes (carbs, then the bolus once Loop stored them): each has its own steps.
            let loopMeal = loopSystem == .loop && (command.map { $0.carbs_g > 0 && $0.insulin_u > 0 } ?? ((viewModel.carbsG ?? 0) > 0 && (viewModel.insulinU ?? 0) > 0))
            if loopMeal {
                let bolusSent = command.map(viewModel.loopBolusWasSent) ?? false
                BolusSendSteps(
                    step: BolusSendSteps.loopMealStep(status: command?.status, bolusSent: bolusSent),
                    givesInsulin: true,
                    sentAt: command.flatMap { ServerDate.parse($0.sent_at ?? $0.authorized_at) },
                    resolution: settlingResolution,
                    resolvedAt: viewModel.settling.map { BolusSendSteps.loopMealResolvedAt(status: $0.status, bolusSent: bolusSent) } ?? 3,
                    loopMeal: true
                )
            } else {
                BolusSendSteps(
                    step: viewModel.outcome?.step ?? 0,
                    givesInsulin: command.map { $0.insulin_u > 0 } ?? ((viewModel.insulinU ?? 0) > 0),
                    sentAt: command.flatMap { ServerDate.parse($0.sent_at ?? $0.authorized_at) },
                    resolution: settlingResolution,
                    resolvedAt: viewModel.settling.map { ["SEND_FAILED", "EXPIRED"].contains($0.status) ? 0 : 2 } ?? 2
                )
            }
        case let .given(command)?:
            BolusOutcomeCard(
                tone: .given,
                title: givenTitle(command),
                subtitle: "",
                details: nil,
                trailing: command.answered_at.flatMap(ServerDate.parse).map(RemoteCommandFormat.time)
            )
        case let .refused(command, reply)?:
            BolusOutcomeCard(
                tone: .refused,
                title: command.insulin_u > 0 ? "Bolus nie został podany" : "Węglowodany nie zostały zapisane",
                subtitle: reply.short,
                details: reply.details,
                footnote: "Wpisane wartości zostały: popraw je albo przesuń ponownie."
            )
        case let .carbsOnly(command, reply)?:
            BolusOutcomeCard(
                tone: .partial,
                title: "Węgle zapisane, bolus nie",
                subtitle: reply.short,
                details: reply.details,
                footnote: "\(command.carbs_g) g jest już w \(loop.locative). Na suwaku zostaje sama insulina."
            )
        case .noReply?:
            BolusOutcomeCard(
                tone: .unknown,
                title: "Nie wiem, czy bolus podano",
                subtitle: "\(loop.capitalized) nie \(loop.agree(m: "odpowiedział", f: "odpowiedziała", n: "odpowiedziało")) w 3:30.",
                details: nil,
                footnote: "Sprawdź w \(loop.locative), zanim podasz ponownie. Wpisane wartości zostały."
            )
        }
    }

    private func givenTitle(_ command: RemoteCommand) -> String {
        let insulin = "\(RemoteCommandFormat.units(command.insulin_u)) j"
        switch (command.insulin_u > 0, command.carbs_g > 0) {
        case (true, true): return "Podano \(insulin) i \(command.carbs_g) g"
        case (true, false): return "Podano \(insulin)"
        default: return "Zapisano \(command.carbs_g) g w \(loop.locative)"
        }
    }

    /// The card's identity for its animation (a new state slides in).
    private var outcomeKey: String {
        switch viewModel.outcome {
        case nil: return viewModel.isLocked ? "sending" : "none"
        case let .waiting(command)?: return "waiting-\(command.status)"
        case let .given(command)?: return "given-\(command.id)"
        case let .refused(command, _)?: return "refused-\(command.id)"
        case let .carbsOnly(command, _)?: return "partial-\(command.id)"
        case let .noReply(command)?: return "noreply-\(command.id)"
        }
    }

    /// The grams Trio already has from a command it gave only the carbs of (the field shows them instead of a value).
    private var carbsInTrio: Int? {
        guard let retry = viewModel.retry, retry.carbsKept else { return nil }
        if case let .carbsOnly(command, _)? = viewModel.outcome { return command.carbs_g }
        return viewModel.recentCommands.first { $0.id == retry.followsCommandID }?.carbs_g ?? 0
    }

    /// "Posiłek za 15 min" in the carbs field's footer: the meal is eaten 15 min from now: the dose from the ICR of that
    /// time, the carbs dated then in Trio (the bolus starts now) and on the chart instead of the usual 10 min after the
    /// bolus. Drawn as an option to tick (an empty circle, then a filled tick on orange): a grey chip read as a label,
    /// "+15" as 15 more grams. A narrow field drops "Posiłek".
    private var mealLaterToggle: some View {
        ViewThatFits(in: .horizontal) {
            mealLaterToggleLabel("Posiłek za \(RemoteBolusViewModel.mealLaterMinutes) min")
            mealLaterToggleLabel("Za \(RemoteBolusViewModel.mealLaterMinutes) min")
        }
    }

    private func mealLaterToggleLabel(_ title: String) -> some View {
        let on = viewModel.mealLater
        return Button { viewModel.mealLater.toggle() } label: {
            Label(title, systemImage: on ? "checkmark.circle.fill" : "circle")
                .labelStyle(BellChipLabelStyle(showsTitle: true))
                .font(.caption.weight(.semibold).monospacedDigit())
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(Capsule().fill(on ? Color.orange.opacity(0.2) : Color.clear))
                .overlay(Capsule().strokeBorder(on ? Color.orange.opacity(0.6) : Color.secondary.opacity(0.45), lineWidth: 1))
                .foregroundStyle(on ? Color.orange : Color.secondary)
                // A finger-sized target (44 pt) around the small chip.
                .padding(.vertical, 9)
                .contentShape(Rectangle())
                .padding(.vertical, -9)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel("Posiłek za \(RemoteBolusViewModel.mealLaterMinutes) min")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityHint("Węglowodany zapisane w \(loop.locative) za \(RemoteBolusViewModel.mealLaterMinutes) min, dawka z ICR na tę godzinę; bolus od razu.")
    }

    /// "Przypomnij" as an alarm clock in the carbs field's header (not a bell: the bell at the top is the notifications,
    /// and a bell with "2" read as two unread ones): outlined until set, then filled with the number of reminders (their
    /// times are in the sheet and the accessibility label).
    private var reminderBell: some View {
        let plan = viewModel.reminderPlan
        let on = !plan.isEmpty
        return Button {
            focusBeforeReminders = focused
            showsReminders = true
        } label: {
            HStack(spacing: 3) {
                Image(systemName: on ? "alarm.fill" : "alarm")
                if on { Text("\(plan.count)").monospacedDigit() }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(on ? Color.white : BolusReminderStyle.tint)
            .padding(.horizontal, on ? 8 : 0)
            .frame(minWidth: 26, minHeight: 26)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(on ? BolusReminderStyle.tint : BolusReminderStyle.tint.opacity(0.16)))
            // A finger-sized target (44 pt) around the small badge.
            .padding(9)
            .contentShape(Rectangle())
            .padding(-9)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel(on ? "Przypomnienia: \(plan.chipText(from: Date()))" : "Przypomnij")
        .accessibilityHint("WBT albo druga dawka po tym bolusie")
    }

    private var slideResetKey: String {
        // The low-glucose step closing (cancelled or confirmed) puts the knob back too.
        "\(viewModel.recentCommands.count)|\(String(describing: viewModel.flow.state))|\(viewModel.slideNotice ?? "")|\(outcomeKey)|\(viewModel.pendingLowGlucoseConfirmation)"
    }

    private var slideTitle: String {
        if viewModel.flow.state == .checking { return "Sprawdzam dane…" }
        let insulin = viewModel.insulinU ?? 0
        switch viewModel.outcome {
        case .carbsOnly? where insulin > 0:
            return "Przesuń, aby podać sam bolus \(RemoteCommandFormat.units(insulin)) j"
        case .refused? where insulin > 0:
            return "Przesuń, aby ponowić \(RemoteCommandFormat.units(insulin)) j"
        default:
            break
        }
        if insulin > 0 { return "Przesuń, aby podać \(RemoteCommandFormat.units(insulin)) j" }
        if let carbs = viewModel.carbsG, carbs > 0 { return "Przesuń, aby wysłać \(carbs) g" }
        return "Wpisz węglowodany lub insulinę"
    }

    /// Who gets it, on its own line: the name never squeezes the amount out of the slider.
    private var slideSubtitle: String? {
        guard viewModel.flow.state != .checking, (viewModel.insulinU ?? 0) > 0 || (viewModel.carbsG ?? 0) > 0 else { return nil }
        // The reminders are said by their chip above: the slider keeps to whom it gives.
        return PatientBadge.firstName(viewModel.flow.patientName).map { "dla: \($0)" }
    }

    /// The slider's text while it is the loader.
    /// Trio's answer while the steps show it, before its card.
    private var settlingResolution: BolusSendSteps.Resolution? {
        viewModel.settling.flatMap { BolusSendSteps.Resolution(status: $0.status) }
    }

    private var progressTitle: String {
        if let command = viewModel.settling, let resolution = settlingResolution {
            switch resolution {
            case .given:
                return command.insulin_u > 0 ? "Podano \(RemoteCommandFormat.units(command.insulin_u)) j" : "Zapisano \(command.carbs_g) g"
            case .refused: return command.insulin_u > 0 ? "Bolus nie został podany" : "Węglowodany nie zostały zapisane"
            case .partial: return "Węgle zapisane, bolus nie"
            case .unknown: return "Brak odpowiedzi \(loop.genitive)"
            }
        }
        guard case let .waiting(command)? = viewModel.outcome else { return "Wysyłam do \(loop.genitive)…" }
        if command.status == "AUTHORIZED" { return "Wysyłam do \(loop.genitive)…" }
        if command.status == "SENT" { return "Czekam na \(loop.genitive)…" }
        if command.insulin_u > 0 { return "\(loop.capitalized) podaje \(RemoteCommandFormat.units(command.insulin_u)) j…" }
        return "\(loop.capitalized) zapisuje \(command.carbs_g) g…"
    }

    /// One amount as a half-width input field: icon and name on top ("z ICR" on the insulin while it is carbs / ICR), the
    /// number large below with its unit (tap anywhere to type, "0" when empty). Locked (a padlock, dimmed) while the
    /// command is on its way; the carbs Trio already has as "✓ 30 g w Trio".
    private func amountField<Footer: View>(
        _ field: Field, label: String, icon: String, text: Binding<String>, unit: String, tint: Color, inTrio: Int?,
        @ViewBuilder footer: () -> Footer
    ) -> some View {
        let isFocused = focused == field
        let locked = viewModel.isLocked
        let valueColor: Color = field == .insulin ? .accentColor : .primary
        return VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 26, height: 26)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint.opacity(0.16)))
                // "Węglowodany" where it fits, "Węgle" on a narrow phone (it was cut to "Węglowo…" on an iPhone SE).
                // A step smaller first, then the short word.
                ViewThatFits(in: .horizontal) {
                    Text(label).font(.footnote).lineLimit(1).fixedSize()
                    Text(label).font(.caption).lineLimit(1).fixedSize()
                    Text(label).font(.caption2).lineLimit(1).fixedSize()
                    Text(field == .carbs ? "Węgle" : label).font(.footnote).lineLimit(1).minimumScaleFactor(0.8)
                }
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(label)
                    // Room for the reminder badge laid over the header, kept also while it is hidden or empty: the label
                    // keeps one size whatever the badge shows.
                    // The insulin's calculator switch the same way.
                    .padding(.trailing, field == .carbs || field == .insulin ? 42 : 0)
                Spacer(minLength: 0)
                if locked {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            if let inTrio {
                Label("\(inTrio) g w \(loop.locative)", systemImage: "checkmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(DashboardPalette.green)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(DashboardPalette.green.opacity(0.14)))
                    .frame(height: 41)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    TextField("0", text: Binding(
                        get: { text.wrappedValue },
                        set: { text.wrappedValue = RemoteCommandFormat.sanitizedAmount($0, decimal: field == .insulin) }
                    ))
                    #if os(iOS)
                    .keyboardType(field == .insulin ? .decimalPad : .numberPad)
                    #endif
                    .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(valueColor)
                    .focused($focused, equals: field)
                    .disabled(locked)
                    .fixedSize()
                    .layoutPriority(2)
                    Text(unit)
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .layoutPriority(2)
                    Spacer(minLength: 0)
                }
                .animation(.easeInOut(duration: 0.2)) { $0.opacity(locked ? 0.45 : 1) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityHint(locked ? "Zablokowane do odpowiedzi \(loop.genitive)" : "")
        // Over the header, not in it: inside, the combined element took the button's tap from VoiceOver.
        .overlay(alignment: .topTrailing) {
            if field == .carbs, showsReminderBell {
                reminderBell
                    .tourAnchor(.reminders)
                    .transition(.scale.combined(with: .opacity))
            } else if field == .carbs, tourStage.showsSampleReminders {
                // The tour's sample: a picture of the alarm clock (no carbs typed yet), never a button.
                Image(systemName: "alarm")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(BolusReminderStyle.tint)
                    .frame(width: 26, height: 26)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(BolusReminderStyle.tint.opacity(0.16)))
                    .allowsHitTesting(false)
                    .tourAnchor(.reminders)
                    .transition(.scale.combined(with: .opacity))
            } else if field == .insulin, let state = viewModel.doseSwitch {
                // The calculator / ICR switch: the segment of the dose in the field filled, neither for a typed dose.
                DoseSourceSwitch(state: state) { segment in
                    withAnimation(.snappy(duration: 0.2)) { viewModel.tapDoseSwitch(segment) }
                }
                .tourAnchor(.doseSource)
                .transition(.scale.combined(with: .opacity))
            } else if field == .insulin, tourStage.showsSampleDoseSource {
                // The tour's sample: a picture of the switch (the calculator filled), never a button.
                DoseSourceSwitch(state: .init(selected: .calculator, addsCorrection: false), isSample: true) { _ in }
                    .tourAnchor(.doseSource)
                    .transition(.scale.combined(with: .opacity))
            }
        }
            // The footer at the bottom: the field grows by what is left over while typing (fieldsExtraHeight).
            Spacer(minLength: compact ? fieldsExtraHeight : 0)
            footer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DashboardPalette.cardBackground))
        // Only the ring fades: an animation on the whole tile would also move it at its own pace when the chart shrinks.
        .animation(.easeInOut(duration: 0.2)) { tile in
            tile
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(isFocused ? Color.accentColor : Color.primary.opacity(locked ? 0.04 : 0.1), lineWidth: isFocused ? 2 : 1)
                )
                .shadow(color: isFocused ? Color.accentColor.opacity(0.3) : .clear, radius: 6)
        }
        .contentShape(Rectangle())
        .onTapGesture { if inTrio == nil && !locked { focused = field } }
    }

    // MARK: Ostatnie i historia

    private var historyView: some View {
        List {
            if viewModel.recentCommands.isEmpty {
                Text("Tu pojawią się polecenia wysłane do \(loop.genitive) z tej zakładki i z rozmów.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(historyDays, id: \.title) { day in
                Section(day.title) {
                    ForEach(day.commands) { command in
                        RemoteCommandHistoryRow(
                            command: command,
                            canRetry: canRetry(command),
                            onRetry: {
                                viewModel.prepareRetry(of: command)
                                segment = .give
                            },
                            onOpenMeal: command.meal_record_id.map { mealID in { onOpenMeal(mealID) } }
                        )
                    }
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
        .refreshable { await viewModel.refreshRecent() }
    }

    private var historyDays: [(title: String, commands: [RemoteCommand])] {
        let calendar = Calendar.current
        var days: [(title: String, commands: [RemoteCommand])] = []
        for command in viewModel.recentCommands {
            guard let date = ServerDate.parse(command.authorized_at) else { continue }
            let title = calendar.isDateInToday(date) ? "Dziś" : calendar.isDateInYesterday(date) ? "Wczoraj" : date.formatted(.dateTime.day().month(.wide))
            if let index = days.firstIndex(where: { $0.title == title }) {
                days[index].commands.append(command)
            } else {
                days.append((title, [command]))
            }
        }
        return days
    }

    /// A refused command can be retried for 30 minutes, once (the newest refusal of its chain), and not while this tab
    /// still waits for Trio.
    private func canRetry(_ command: RemoteCommand) -> Bool {
        guard !viewModel.isLocked, command.status == "PARTIAL" || command.status == "REJECTED", let date = ServerDate.parse(command.authorized_at) else { return false }
        let retried = viewModel.recentCommands.contains { $0.follows_command_id == command.id }
        return !retried && Date().timeIntervalSince(date) < 30 * 60
    }
}

// MARK: - Glucose and forecast

/// The Bolus tab's checks in one row (1.0.5): icon, the most serious item's few words (one line), the others counted in
/// a "+N" pill and a chevron, in its colour (red: blocks, the forecast below 70, DANGER; orange: warnings). A tap lists
/// every item with its full text. VoiceOver: the headline in words and how many others ("…, i 4 inne ostrzeżenia").
struct BolusChecksRow: View {
    let summary: BolusCheckSummary
    @Binding var expanded: Bool

    var body: some View {
        if let headline = summary.headline {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.snappy(duration: 0.25)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: Self.icon(headline))
                            .font(.footnote.weight(.semibold))
                        // One line, cut before the badge: never wraps.
                        Text(headline.headline)
                            .font(.footnote.weight(.semibold))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 4)
                        // The others, counted in a small pill of the row's colour before the chevron.
                        if let badge = summary.badgeText {
                            Text(badge)
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Self.color(headline).opacity(0.16)))
                                .fixedSize()
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .foregroundStyle(Self.color(headline))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(expanded ? summary.accessibilityText : (summary.collapsedAccessibilityText ?? summary.accessibilityText))
                .accessibilityHint(expanded ? "Stuknij, żeby zwinąć" : "Stuknij, żeby rozwinąć")
                .accessibilityIdentifier("bolus.checks")
                if expanded {
                    Divider().padding(.horizontal, 12)
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(summary.items) { item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: Self.icon(item))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Self.color(item))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.headline)
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(item.level == .repeated ? Color.secondary : Self.color(item))
                                    if let detail = item.detail {
                                        Text(detail)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .transition(.opacity)
                }
            }
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Self.color(headline).opacity(0.1)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Self.color(headline).opacity(0.25), lineWidth: 1))
        }
    }

    static func color(_ item: BolusCheckItem) -> Color {
        switch item.level {
        case .block, .danger: return .red
        case .warning: return .orange
        case .repeated: return .secondary
        }
    }

    static func icon(_ item: BolusCheckItem) -> String {
        switch item.level {
        case .block: return "xmark.octagon.fill"
        case .danger: return "exclamationmark.octagon.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .repeated: return "info.circle"
        }
    }
}

/// The glucose as on the dashboard: the value in its level's colour, the trend arrow in a translucent circle and the
/// 5-minute change, the reading's age under them; IOB over COB on the right (fits a smaller phone with long values).
struct BolusGlucoseRow: View {
    let context: RemoteCommandContextView?
    var loading = false
    let now: Date

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if let glucose = context?.glucose {
                VStack(alignment: .leading, spacing: 2) {
                    valueRow(glucose)
                    age(glucose.observed_at)
                }
            } else if loading {
                // Same height as a value and its age, so nothing moves when it arrives.
                VStack(alignment: .leading, spacing: 2) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(DashboardPalette.chipBackground)
                        .frame(width: 120, height: 34)
                        .padding(.vertical, 3.5)
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(DashboardPalette.chipBackground)
                        .frame(width: 70, height: 12)
                        .padding(.vertical, 2)
                }
                .modifier(SkeletonPulse())
            } else {
                Text(context == nil ? "—" : "Brak odczytu")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .frame(height: 59)
            }
            Spacer(minLength: 4)
            loopLine
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    private func valueRow(_ glucose: RemoteCommandContextView.Glucose) -> some View {
        let value = Int(glucose.value.rounded())
        let level = DashboardThresholds.glucose(value)
        return HStack(alignment: .center, spacing: 8) {
            Text("\(value)")
                .font(.system(size: 34, weight: .bold))
                .monospacedDigit()
                .tracking(-0.5)
                .foregroundStyle(DashboardPalette.glucose(level))
                .contentTransition(.numericText(value: Double(value)))
                .animation(.snappy, value: value)
            if let direction = BolusGlucoseStrip.direction(glucose) {
                TrendArrow(direction: direction)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(level == .normal ? Color.primary : DashboardPalette.color(level))
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(level == .normal ? DashboardPalette.chipBackground : DashboardPalette.color(level).opacity(0.18)))
            }
            if let delta = glucose.delta {
                Text(DashboardFormat.signedDelta(Int(delta.rounded())))
                    .font(.system(size: 17, weight: .bold))
                    .monospacedDigit()
                    .accessibilityLabel("Zmiana \(DashboardFormat.signedDelta(Int(delta.rounded()))) mg/dL na 5 minut")
            }
        }
    }

    private func age(_ observedAt: String) -> some View {
        let minutes = ServerDate.parse(observedAt).map { DashboardFormat.wholeMinutes(since: $0, now: now) } ?? 0
        let level = DashboardThresholds.readingAge(minutes: minutes)
        return Text(minutes == 0 ? "teraz" : "\(minutes) min temu")
            .font(.caption)
            .fontWeight(level == .normal ? .regular : .semibold)
            .foregroundStyle(level == .normal ? Color.secondary : DashboardPalette.color(level))
            .fixedSize()
    }

    @ViewBuilder
    private var loopLine: some View {
        let iob = context?.loop?.iob_units.map { "\(RemoteCommandFormat.units($0)) j" }
        let cob = context?.loop?.cob_grams.map { "\(Int($0.rounded())) g" }
        if iob != nil || cob != nil {
            // The same size as in the chart's header while typing.
            VStack(alignment: .trailing, spacing: 1) {
                Text("IOB ").foregroundStyle(.secondary) + Text(iob ?? "—").fontWeight(.semibold)
                Text("COB ").foregroundStyle(.secondary) + Text(cob ?? "—").fontWeight(.semibold)
            }
            .font(.subheadline)
            .monospacedDigit()
            .fixedSize()
        }
    }
}

/// The glucose row in one short line, for the chart's header while typing: value, trend and change on the left with the
/// reading's age, IOB and COB on the right (under each other when the line is too long for the phone).
struct BolusGlucoseInline: View {
    let context: RemoteCommandContextView?
    let now: Date

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                glucose(shortAge: false)
                Spacer(minLength: 6)
                loop(stacked: false)
            }
            HStack(spacing: 8) {
                glucose(shortAge: false)
                Spacer(minLength: 6)
                loop(stacked: true)
            }
            HStack(spacing: 8) {
                glucose(shortAge: true)
                Spacer(minLength: 6)
                loop(stacked: true)
            }
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func glucose(shortAge: Bool) -> some View {
        if let glucose = context?.glucose {
            let value = Int(glucose.value.rounded())
            let level = DashboardThresholds.glucose(value)
            let minutes = ServerDate.parse(glucose.observed_at).map { DashboardFormat.wholeMinutes(since: $0, now: now) } ?? 0
            let age = DashboardThresholds.readingAge(minutes: minutes)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text("\(value)")
                    .font(.system(size: 22, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(DashboardPalette.glucose(level))
                if let direction = BolusGlucoseStrip.direction(glucose) {
                    TrendArrow(direction: direction)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(level == .normal ? Color.primary : DashboardPalette.color(level))
                }
                if let delta = glucose.delta {
                    Text(DashboardFormat.signedDelta(Int(delta.rounded())))
                        .font(.system(size: 16, weight: .bold))
                        .monospacedDigit()
                }
            }
            .fixedSize()
            // The reading's age apart from the change (a clock, its own capsule): "+7 147 min" read as one number.
            Label(minutes == 0 ? "teraz" : (shortAge ? "\(minutes) min" : "\(minutes) min temu"), systemImage: "clock")
                .labelStyle(.titleAndIcon)
                .font(.caption)
                .fontWeight(age == .normal ? .regular : .semibold)
                .foregroundStyle(age == .normal ? Color.secondary : DashboardPalette.color(age))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(age == .normal ? DashboardPalette.chipBackground : DashboardPalette.color(age).opacity(0.15)))
                .fixedSize()
        } else {
            Text("Brak odczytu").font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func loop(stacked: Bool) -> some View {
        let iob = context?.loop?.iob_units.map { "\(RemoteCommandFormat.units($0)) j" }
        let cob = context?.loop?.cob_grams.map { "\(Int($0.rounded())) g" }
        if iob != nil || cob != nil {
            let iobText = Text("IOB ").foregroundStyle(.secondary) + Text(iob ?? "—").fontWeight(.semibold)
            let cobText = Text("COB ").foregroundStyle(.secondary) + Text(cob ?? "—").fontWeight(.semibold)
            Group {
                if stacked {
                    VStack(alignment: .trailing, spacing: 1) { iobText; cobText }
                } else {
                    iobText + Text("  ·  ").foregroundStyle(.secondary) + cobText
                }
            }
            .font(.subheadline)
            .monospacedDigit()
            .fixedSize()
        }
    }
}

/// A gentle pulse for skeleton shapes (still with Reduce Motion).
struct SkeletonPulse: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(dim ? 0.45 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}

/// The forecast card: "Prognoza" with the legend (or what is being worked out) in its header and the chart under it;
/// a pulsing skeleton of the chart while it loads, as the dashboard's cards do.
struct BolusForecastCard: View {
    /// The loop the commands go to, by name (Trio, Loop).
    @Environment(\.loopSystem) private var loopSystem
    private var loop: LoopSystemNames { loopSystem.names }
    let readings: [DashboardReading]
    let forecast: BolusForecastChart?
    let hasGlucose: Bool
    var updating = false
    var loading = false
    /// Smaller while a field is being typed in (the keyboard takes half the screen).
    var compact = false
    var compactChartHeight: CGFloat = 72
    /// The glucose, IOB and COB shown in the header while typing (the row above the chart makes way then).
    var context: RemoteCommandContextView? = nil
    /// The ⓘ next to "Prognoza": how to read the line.
    @State private var showsInfo = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if compact {
                // No loader here (it pushed IOB and COB aside): the chart shows it while typing.
                TimelineView(.periodic(from: .now, by: 15)) { timeline in
                    BolusGlucoseInline(context: context, now: timeline.date)
                }
                .transition(.opacity)
            } else {
            HStack(spacing: 8) {
                Text("Prognoza")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let forecast, !loading {
                    Button { showsInfo = true } label: {
                        Image(systemName: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Jak czytać prognozę")
                    .popover(isPresented: $showsInfo) {
                        Text(forecastExplanation(forecast))
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(idealWidth: 280)
                            .padding()
                            .presentationCompactAdaptation(.popover)
                    }
                }
                Spacer(minLength: 4)
                ZStack(alignment: .trailing) {
                    if loading || updating {
                        HStack(spacing: 5) {
                            ProgressView().controlSize(.mini)
                            Text(loading ? "liczę prognozę" : "przeliczam")
                        }
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                    } else if let forecast {
                        HStack(spacing: 10) {
                            if forecast.isLoopOnly {
                                // Only the loop's own forecast: it does not include a dose not yet given.
                                legendLine(forecast.baseline_source == "LOOP" ? "\(loop.nominative), bez tej dawki" : "trend CGM, bez tej dawki", color: .accentColor, dashed: false)
                                // The dose's insulin above the carbs (excess-insulin.v1), when it differs from the ICR dose.
                                if forecast.excessLine != nil {
                                    legendLine("z tą dawką", color: BolusForecastChartView.excessColor, dashed: true)
                                }
                            } else {
                                if forecast.with_dose != nil {
                                    legendLine("z tą dawką", color: .accentColor, dashed: false)
                                }
                                legendLine("bez", color: .secondary, dashed: true)
                            }
                        }
                        .transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: loading || updating)
            }
            .transition(.opacity)
            }
            // One chart from the first read on: its frame and the readings at once, the forecast drawn in when it comes.
            if loading || readings.count >= 2 || forecast != nil {
                BolusForecastChartView(readings: readings, forecast: forecast, updating: updating, pending: loading)
                    .frame(height: compact ? compactChartHeight : 190)
                    // While typing the header has no room for "przeliczam": a veil over the chart with it in the middle.
                    .overlay {
                        if compact && updating {
                            ZStack {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(DashboardPalette.cardBackground.opacity(0.55))
                                HStack(spacing: 8) {
                                    ProgressView().controlSize(.small)
                                    Text("Przeliczam prognozę")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .background(Capsule().fill(.regularMaterial))
                                .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
                            }
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                        }
                    }
                    .animation(.easeInOut(duration: 0.25), value: compact && updating)
                    .transition(.opacity)
            } else {
                Text("Brak odczytów z ostatnich 2 godzin.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: compact ? compactChartHeight : 120)
            }
            if !compact, !loading {
                // At most one line under the chart (1.0.5): the legend says "Trio, bez tej dawki" already; the longer
                // explanation is behind the ⓘ next to "Prognoza".
                if let forecast, forecast.baseline_source != "LOOP" {
                    Text("Brak prognozy \(loop.genitive): linia z trendu CGM.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                } else if forecast == nil, hasGlucose {
                    Text("Bez prognozy: brak świeżego odczytu.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: loading)
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(DashboardPalette.cardBackground))
    }

    /// Behind the ⓘ: what the line is (it was the caption under the chart until 1.0.5).
    private func forecastExplanation(_ forecast: BolusForecastChart) -> String {
        if forecast.baseline_source != "LOOP" {
            return "Brak świeżej prognozy \(loop.genitive): linia bez dawki jest z trendu CGM."
        }
        if forecast.isLoopOnly, forecast.excessLine != nil {
            return "Linia przerywana: prognoza pętli z tą dawką. Mellis liczy tylko insulinę ponad węglowodany z przelicznika (dawka − węglowodany/ICR), rozłożoną w czasie według działania insuliny."
        }
        if forecast.isLoopOnly {
            return "Linia to prognoza \(loop.genitive). Tej dawki na niej nie ma: \(loop.nominative) uwzględni ją dopiero po podaniu."
        }
        return "Linia ciągła to prognoza z tą dawką, przerywana bez niej."
    }

    private func legendLine(_ title: String, color: Color, dashed: Bool) -> some View {
        HStack(spacing: 5) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: 1))
                path.addLine(to: CGPoint(x: 14, y: 1))
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, dash: dashed ? [3, 2] : []))
            .frame(width: 14, height: 2)
            Text(title)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
}

/// Helpers the Bolus tab and the confirmation share for the glucose's trend.
enum BolusGlucoseStrip {
    /// The trend as every screen shows it (GlucoseTrend).
    static func direction(_ glucose: RemoteCommandContextView.Glucose) -> String? {
        GlucoseTrend.direction(nightscout: glucose.direction, delta: glucose.delta)
    }

    static func arrowCharacter(_ direction: String?) -> String? {
        GlucoseTrend.arrowCharacter(direction)
    }
}

/// The last 2 hours of readings (dots in their level's colour) and the 3 hours ahead (bolus-forecast.v1): the 70–180
/// band, now, the line without the dose dashed, the line with it solid in a band that widens with time (it is only a
/// forecast), a red dot where it first goes below 70. The scale starts at 220 like the dashboard's.
struct BolusForecastChartView: View {
    let readings: [DashboardReading]
    let forecast: BolusForecastChart?
    /// The forecast is being worked out for new amounts: the old one fades (the card's header says so).
    var updating = false
    /// The chart is still being read: its frame is there with a sheen over it, then the readings and the forecast are
    /// drawn in together from the left.
    var pending = false

    /// How much of the readings and the forecast is shown, from the left (0 → 1 as they are drawn in).
    @State private var reveal: CGFloat = 1
    /// The plot's edges in the chart's own space (for the sheen and the drawing in).
    @State private var plotMinX: CGFloat = 0
    @State private var plotMaxX: CGFloat = 0
    @State private var plotMinY: CGFloat = 0
    @State private var plotMaxY: CGFloat = 0

    private static let pastSeconds: TimeInterval = 2 * 3600
    private static let aheadSeconds: TimeInterval = 3 * 3600
    private static let lowestTop = 220.0

    private struct Scale {
        let now: Date
        let past: [(date: Date, value: Int)]
        let baseline: [BolusForecastChart.Point]
        let withDose: [BolusForecastChart.Point]
        /// The dashed "z tą dawką" line (excess-insulin.v1) next to the loop's own.
        let excess: [BolusForecastChart.Point]
        /// Its lowest point when below 70 (the red dot, the warning's value).
        let excessLow: BolusForecastChart.Point?
        let banded: [BolusForecastChart.Point]
        let lowPoint: BolusForecastChart.Point?
        let start: Date
        let end: Date
        let minValue: Double
        let maxValue: Double
        let lines: [(Double, Color)]
    }

    private func scale() -> Scale {
        // To the minute: the chart is the same between redraws within a minute.
        let now = Date(timeIntervalSince1970: (Date().timeIntervalSince1970 / 60).rounded(.down) * 60)
        let past = readings.compactMap { reading in ServerDate.parse(reading.at).map { (date: $0, value: reading.value) } }
            .filter { $0.date >= now.addingTimeInterval(-Self.pastSeconds) && $0.date <= now }
            .sorted { $0.date < $1.date }
        let baseline = forecast.map { $0.points($0.baseline) } ?? []
        let withDose = forecast.flatMap { chart in chart.with_dose.map { chart.points($0) } } ?? []
        let banded = withDose.isEmpty ? baseline : withDose
        let lowPoint = forecast?.lowDate.flatMap { low in (forecast?.isLoopOnly == true ? baseline : withDose).first { $0.date >= low } }
        let excess = forecast.flatMap { chart in chart.excessLine.map { chart.points($0) } } ?? []
        let excessLow = excess.min { $0.value < $1.value }.flatMap { $0.value < 70 ? $0 : nil }
        let start = now.addingTimeInterval(-Self.pastSeconds)
        let end = max(now, baseline.last?.date ?? now).addingTimeInterval(baseline.isEmpty ? Self.aheadSeconds : 0)
        let values = past.map(\.value) + baseline.map(\.value) + withDose.map(\.value) + excess.map(\.value)
        let minValue = min(40.0, Double((values.min() ?? 40) - 10))
        let maxValue = max(Self.lowestTop, ((Double(values.max() ?? 0) + 10) / 25).rounded(.up) * 25)
        let lines: [(Double, Color)] = [(250, DashboardPalette.red.opacity(0.45)), (180, DashboardPalette.yellow.opacity(0.7)), (70, DashboardPalette.red.opacity(0.7))].filter { $0.0 < maxValue }
        return Scale(now: now, past: past, baseline: baseline, withDose: withDose, excess: excess, excessLow: excessLow, banded: banded, lowPoint: lowPoint, start: start, end: end, minValue: minValue, maxValue: maxValue, lines: lines)
    }

    var body: some View {
        let scale = scale()
        ZStack {
            frameChart(scale)
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        let frame = proxy.plotFrame.map { geometry[$0] } ?? .zero
                        Color.clear
                            .onAppear { place(frame) }
                            .onChange(of: frame) { _, value in place(value) }
                    }
                }
            // The readings and the forecast are one picture, drawn in together from the left once both are there (on
            // layers of their own with the same scales; their labels are kept, clear, so every plot is the same size).
            Group {
                readingsChart(scale)
                forecastChart(scale)
            }
            .mask(alignment: .leading) {
                Rectangle().frame(width: max(0, plotMinX + (plotMaxX - plotMinX) * reveal + 2))
            }
            .allowsHitTesting(false)
            if pending, plotMaxX > plotMinX {
                sheenView
            }
        }
        .onChange(of: pending) { wasPending, isPending in
            guard wasPending, !isPending else { return }
            reveal = 0
            withAnimation(.easeOut(duration: 0.6)) { reveal = 1 }
        }
        .onAppear { if pending { reveal = 0 } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(pending ? "Wykres glukozy: liczę prognozę" : updating ? "Wykres glukozy: przeliczam prognozę" : accessibilityText(withDose: scale.withDose, baseline: scale.baseline, excess: scale.excess))
    }

    /// Only a real move is kept: storing every fraction of a point redrew the chart again and again (the Bolus tab froze).
    private func place(_ frame: CGRect) {
        let moved = abs(frame.minX - plotMinX) >= 1 || abs(frame.maxX - plotMaxX) >= 1 || abs(frame.minY - plotMinY) >= 1 || abs(frame.maxY - plotMaxY) >= 1
        guard moved else { return }
        plotMinX = frame.minX.rounded()
        plotMaxX = frame.maxX.rounded()
        plotMinY = frame.minY.rounded()
        plotMaxY = frame.maxY.rounded()
    }

    /// A soft light passing over the whole plot while the chart is read. Driven by the clock of its own TimelineView, so
    /// it stops with the view (a repeating animation on the chart's state kept ticking after it).
    private var sheenView: some View {
        let width = plotMaxX - plotMinX
        let height = max(0, plotMaxY - plotMinY)
        return TimelineView(.animation) { context in
            let phase = CGFloat(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6)
            Rectangle()
                .fill(LinearGradient(colors: [.clear, Color.primary.opacity(0.07), .clear], startPoint: .leading, endPoint: .trailing))
                .frame(width: width * 0.4, height: height)
                .offset(x: plotMinX - width * 0.4 + phase * width * 1.4, y: plotMinY)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .mask(alignment: .topLeading) {
            Rectangle()
                .frame(width: width, height: height)
                .offset(x: plotMinX, y: plotMinY)
        }
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    /// The chart's frame: the range, the thresholds, now and the hours. Shown at once, never animated.
    private func frameChart(_ scale: Scale) -> some View {
        Chart {
            RectangleMark(xStart: .value("Od", scale.start), xEnd: .value("Do", scale.end), yStart: .value("Dół", 70), yEnd: .value("Góra", 180))
                .foregroundStyle(DashboardPalette.green.opacity(0.08))
            RectangleMark(xStart: .value("Teraz", scale.now), xEnd: .value("Do", scale.end), yStart: .value("Dół", scale.minValue), yEnd: .value("Góra", scale.maxValue))
                .foregroundStyle(Color.primary.opacity(0.03))
            ForEach(scale.lines, id: \.0) { line in
                RuleMark(y: .value("Próg", line.0))
                    .foregroundStyle(line.1)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
            RuleMark(x: .value("Teraz", scale.now))
                .foregroundStyle(Color.primary.opacity(0.3))
                .lineStyle(StrokeStyle(lineWidth: 1))
        }
        .modifier(BolusChartScales(start: scale.start, end: scale.end, minValue: scale.minValue, maxValue: scale.maxValue, yMarks: scale.lines.map(\.0), hourMarks: Self.hourMarks(from: scale.start, to: scale.end), labels: true))
    }

    /// The readings of the last 2 hours. Readings coming in are not animated (Charts flew them in from the top left
    /// corner); the layout still is, with the other layers (the keyboard coming up moves them all together).
    private func readingsChart(_ scale: Scale) -> some View {
        Chart {
            ForEach(scale.past, id: \.date) { reading in
                PointMark(x: .value("Czas", reading.date), y: .value("mg/dL", reading.value))
                    .symbolSize(14)
                    .foregroundStyle(DashboardPalette.glucose(DashboardThresholds.glucose(reading.value)))
            }
        }
        .modifier(BolusChartScales(start: scale.start, end: scale.end, minValue: scale.minValue, maxValue: scale.maxValue, yMarks: scale.lines.map(\.0), hourMarks: Self.hourMarks(from: scale.start, to: scale.end), labels: false))
        .animation(nil, value: scale.past.count)
    }

    /// The forecast alone: its band, the line without the dose, the one with it, a low and the meal put off.
    private func forecastChart(_ scale: Scale) -> some View {
        Chart {
            ForEach(scale.banded, id: \.date) { point in
                AreaMark(x: .value("Czas", point.date), yStart: .value("Od", max(Int(scale.minValue), point.value - point.band)), yEnd: .value("Do", min(Int(scale.maxValue), point.value + point.band)), series: .value("Seria", "Pasmo"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.accentColor.opacity(updating ? 0.05 : 0.14))
            }
            // Alone (LOOP_ONLY, bolus-forecast.v7) the loop's line is the chart's line; next to the one with the dose, dashed.
            ForEach(scale.baseline, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Bez dawki"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(loopOnly ? Color.accentColor.opacity(updating ? 0.3 : 1) : Color.secondary.opacity(updating ? 0.4 : 1))
                    .lineStyle(loopOnly ? StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round) : StrokeStyle(lineWidth: 1.6, dash: [4, 3]))
            }
            ForEach(scale.withDose, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Z dawką"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.accentColor.opacity(updating ? 0.3 : 1))
                    .lineStyle(StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
            }
            // "z tą dawką" (excess-insulin.v1): the loop's line minus the insulin above the carbs, dashed in a darker
            // brand tone (a light one in dark mode) over the loop's solid line.
            ForEach(scale.excess, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Z tą dawką"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Self.excessColor.opacity(updating ? 0.3 : 1))
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, dash: [5, 3]))
            }
            // The meal put off on the chart ("Posiłek za 15 min"): when the carbs start.
            if let mealIn = forecast?.meal_in_minutes, mealIn > 10, !scale.withDose.isEmpty {
                RuleMark(x: .value("Posiłek", scale.now.addingTimeInterval(Double(mealIn) * 60)))
                    .foregroundStyle(Color.orange.opacity(0.8))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .annotation(position: .top, alignment: .center, spacing: 0) {
                        Image(systemName: "fork.knife").font(.caption2).foregroundStyle(Color.orange)
                    }
            }
            if let lowPoint = scale.lowPoint {
                PointMark(x: .value("Czas", lowPoint.date), y: .value("mg/dL", lowPoint.value))
                    .symbolSize(50)
                    .foregroundStyle(DashboardPalette.red)
            }
            if let excessLow = scale.excessLow {
                PointMark(x: .value("Czas", excessLow.date), y: .value("mg/dL", excessLow.value))
                    .symbolSize(50)
                    .foregroundStyle(DashboardPalette.red)
            }
        }
        .modifier(BolusChartScales(start: scale.start, end: scale.end, minValue: scale.minValue, maxValue: scale.maxValue, yMarks: scale.lines.map(\.0), hourMarks: Self.hourMarks(from: scale.start, to: scale.end), labels: false))
    }

    /// Full hours inside the chart, none in the last 35 minutes (its label would be cut at the edge).
    private static func hourMarks(from start: Date, to end: Date) -> [Date] {
        let calendar = Calendar.current
        guard var hour = calendar.nextDate(after: start, matching: DateComponents(minute: 0), matchingPolicy: .nextTime) else { return [] }
        var marks: [Date] = []
        while hour < end.addingTimeInterval(-35 * 60) {
            marks.append(hour)
            hour = hour.addingTimeInterval(3600)
        }
        return marks
    }

    private func accessibilityText(withDose: [BolusForecastChart.Point], baseline: [BolusForecastChart.Point], excess: [BolusForecastChart.Point]) -> String {
        guard let last = (withDose.isEmpty ? baseline : withDose).last else { return "Wykres glukozy z ostatnich 2 godzin" }
        let low = forecast?.lowDate.map { ", poniżej 70 około \(RemoteCommandFormat.time($0))" } ?? ""
        let total: String
        if let lowest = forecast?.excessLineMin, !excess.isEmpty {
            total = ", z tą dawką najniżej około \(lowest) mg/dL"
        } else if forecast?.isLoopOnly == true, forecast?.hasExcessModel != true {
            total = forecast?.total_with_dose.map { ", z pełnym działaniem tej dawki około \($0) mg/dL" } ?? ""
        } else {
            total = ""
        }
        return "Wykres glukozy: prognoza \(withDose.isEmpty ? "bez dawki" : "z tą dawką") za 3 godziny około \(last.value) mg/dL\(low)\(total)"
    }

    /// Only the loop's own forecast is drawn (bolus-forecast.v7).
    private var loopOnly: Bool { forecast?.isLoopOnly == true }

    /// The dashed "z tą dawką" line and its legend: the logo's petrol, darker than the brand's line in light mode and a
    /// light teal in dark mode, where petrol would vanish.
    static let excessColor = Brand.petrol
}

/// The forecast chart's scales and axes, the same on both of its layers (the forecast's layer keeps its labels, clear,
/// so both plots are the same size).
private struct BolusChartScales: ViewModifier {
    let start: Date
    let end: Date
    let minValue: Double
    let maxValue: Double
    let yMarks: [Double]
    let hourMarks: [Date]
    let labels: Bool

    func body(content: Content) -> some View {
        content
            .chartXScale(domain: start...end)
            .chartYScale(domain: minValue...maxValue)
            .chartXAxis {
                AxisMarks(values: hourMarks) { _ in
                    AxisGridLine().foregroundStyle(labels ? Color.secondary.opacity(0.15) : Color.clear)
                    AxisValueLabel(format: .dateTime.hour().minute()).foregroundStyle(labels ? Color.secondary : Color.clear)
                }
            }
            .chartYAxis {
                AxisMarks(position: .trailing, values: yMarks) { _ in
                    AxisValueLabel().foregroundStyle(labels ? Color.secondary : Color.clear)
                }
            }
    }
}

// MARK: - Sending and Trio's answer

/// The command on its way: sent, Trio accepted, given (or the meal stored), with the time since it was sent.
struct BolusSendSteps: View {
    /// The loop the commands go to, by name (Trio, Loop).
    @Environment(\.loopSystem) private var loopSystem
    private var loop: LoopSystemNames { loopSystem.names }
    /// Trio's final answer, shown on the steps for a moment before its card replaces them.
    enum Resolution: Equatable {
        case given, refused, partial, unknown

        init?(status: String) {
            switch status {
            case "SUCCEEDED": self = .given
            case "REJECTED", "SEND_FAILED", "EXPIRED": self = .refused
            case "PARTIAL": self = .partial
            case "NO_REPLY": self = .unknown
            default: return nil
            }
        }

        var color: Color {
            switch self {
            case .given: DashboardPalette.green
            case .refused, .partial: DashboardPalette.red
            case .unknown: DashboardPalette.yellow
            }
        }

        var icon: String {
            switch self {
            case .given: "checkmark"
            case .refused: "xmark"
            case .partial: "exclamationmark"
            case .unknown: "questionmark"
            }
        }
    }

    /// 0 being sent, 1 sent (Trio has not answered), 2 Trio accepted and works on it. A meal to Loop: 0 carbs being
    /// sent, 1 waiting for Loop to store them, 2 the bolus being sent, 3 waiting for Loop to start it.
    let step: Int
    let givesInsulin: Bool
    let sentAt: Date?
    var resolution: Resolution? = nil
    /// The step the answer belongs to: the last one, or the first when the command never reached Trio.
    var resolvedAt = 2
    /// A meal to Loop: carbs and bolus are separate pushes, so separate steps.
    var loopMeal = false

    /// Steps before this one are done (checked).
    private var doneUpTo: Int { resolution == nil ? step : resolvedAt }

    /// A meal to Loop: the server's status (SENT: the carbs left; TRIO_ACCEPTED: Loop stored them) and whether this
    /// phone sent the bolus push since. The bolus goes only after Loop confirmed the carbs, so a sent bolus is ahead
    /// of the server's status (read every 2 s) and moves the steps on at once.
    static func loopMealStep(status: String?, bolusSent: Bool) -> Int {
        if bolusSent { return 3 }
        switch status {
        case nil, "AUTHORIZED": return 0
        case "SENT": return 1
        case "TRIO_ACCEPTED": return 2
        default: return 3
        }
    }

    /// Where a meal to Loop ended: never sent, the carbs refused or unconfirmed, or at the bolus.
    static func loopMealResolvedAt(status: String, bolusSent: Bool) -> Int {
        switch status {
        case "SEND_FAILED", "EXPIRED": 0
        case "REJECTED": 1
        case "NO_REPLY": bolusSent ? 3 : 1
        case "PARTIAL": bolusSent ? 3 : 2
        default: 3
        }
    }

    private var titles: [String] {
        let failed = resolution.map { $0 != .given } ?? false
        func title(_ index: Int, _ normal: String) -> String {
            guard failed, index == resolvedAt else { return normal }
            switch resolution {
            case .refused?: return index == 0 ? (loopMeal ? "Nie\nwysłano" : "Nie wysłano") : "Odrzucone"
            case .partial?: return loopMeal ? "Tylko\nwęgle" : "Tylko węgle"
            case .unknown?: return loopMeal ? "Brak\nodpowiedzi" : "Brak odpowiedzi"
            default: return normal
            }
        }
        if loopMeal {
            return [title(0, "Węgle\nwysłane"), title(1, "Węgle\nzapisane"), title(2, "Bolus\nwysłany"), title(3, "Bolus\npodany")]
        }
        return [
            title(0, "Wysłane"),
            "\(loop.capitalized) \(loop.agree(m: "przyjął", f: "przyjęła", n: "przyjęło"))",
            title(2, givesInsulin ? "Bolus podany" : "Posiłek zapisany"),
        ]
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 0) {
                let titles = titles
                ForEach(titles.indices, id: \.self) { index in
                    if index > 0 { connector(done: doneUpTo >= index) }
                    dot(index, titles[index])
                }
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(caption(now: context.date))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    // Two lines kept also for a one-line text: the card does not shrink when Trio answers.
                    .lineLimit(2, reservesSpace: true)
                    .contentTransition(.opacity)
            }
        }
        .sensoryFeedback(trigger: resolution) { _, new in
            switch new {
            case .given?: .success
            case nil: nil
            default: .warning
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DashboardPalette.cardBackground))
        .accessibilityElement(children: .combine)
    }

    private func caption(now: Date) -> String {
        switch resolution {
        case .given?: return "Gotowe"
        case .refused?: return resolvedAt == 0 ? "Polecenie nie dotarło do \(loop.genitive)" : "\(loop.capitalized) \(loop.agree(m: "odrzucił", f: "odrzuciła", n: "odrzuciło")) polecenie"
        case .partial?: return "\(loop.capitalized) \(loop.agree(m: "zapisał", f: "zapisała", n: "zapisało")) węgle, bolusu nie \(loop.agree(m: "podał", f: "podała", n: "podało"))"
        case .unknown? where loopMeal && resolvedAt < 3: return "\(loop.capitalized) nie \(loop.agree(m: "potwierdził", f: "potwierdziła", n: "potwierdziło")) węgli: bolusu nie wysłano"
        case .unknown?: return "\(loop.capitalized) nie \(loop.agree(m: "odpowiedział", f: "odpowiedziała", n: "odpowiedziało")) na czas"
        case nil: break
        }
        let doing: String
        if loopMeal {
            doing = switch step {
            case 0: "Potwierdź Face ID, wysyłam węgle"
            case 1: "Czekam, aż \(loop.nominative) zapisze węgle"
            case 2: "Węgle zapisane, wysyłam bolus"
            default: "Czekam, aż \(loop.nominative) rozpocznie bolus"
            }
        } else {
            doing = switch step {
            case 0: "Potwierdź Face ID, wysyłam polecenie"
            case 1: "Czekam, aż \(loop.nominative) odbierze polecenie"
            default: givesInsulin ? "\(loop.capitalized) podaje bolus" : "\(loop.capitalized) zapisuje posiłek"
            }
        }
        guard step > 0, let sentAt else { return doing }
        return "\(doing) · \(RemoteCommandFormat.clock(now.timeIntervalSince(sentAt)))\nzwykle do 1 min, najdłużej 3:30"
    }

    private func dot(_ index: Int, _ title: String) -> some View {
        VStack(spacing: 6) {
            ZStack {
                if let resolution, index == resolvedAt {
                    // Trio's answer on its step: the moment before the card.
                    Circle().fill(resolution.color)
                    Image(systemName: resolution.icon)
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(.white)
                        .transition(.scale.combined(with: .opacity))
                } else if doneUpTo > index {
                    Circle().fill(DashboardPalette.green)
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(.white)
                        .transition(.scale.combined(with: .opacity))
                } else if resolution == nil, step == index {
                    Circle().strokeBorder(Color.accentColor.opacity(0.25), lineWidth: 2.5)
                    SpinningArc()
                } else {
                    Circle().strokeBorder(Color.secondary.opacity(0.3), lineWidth: 2)
                }
            }
            .frame(width: 24, height: 24)
            let reached = doneUpTo >= index
            Text(title)
                .font(.caption2.weight(reached ? .semibold : .regular))
                .foregroundStyle(resolution != nil && index == resolvedAt && resolution != .given ? resolution!.color : reached ? Color.primary : Color.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(loopMeal ? 2 : 1)
                .fixedSize()
        }
        .frame(width: loopMeal ? 68 : 92)
        .animation(.snappy(duration: 0.3), value: step)
        .animation(.snappy(duration: 0.3), value: resolution)
    }

    private func connector(done: Bool) -> some View {
        Capsule()
            .fill(done ? DashboardPalette.green : Color.secondary.opacity(0.25))
            .frame(height: 2)
            .padding(.top, 11)
            .frame(maxWidth: .infinity)
            .animation(.easeInOut(duration: 0.3), value: done)
    }
}

/// A quarter of a ring turning, in the brand's colour (a ProgressView cannot be drawn on a ring). Also the dashboard's
/// refresh around the trend circle.
struct SpinningArc: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var lineWidth: CGFloat = 2.5
    var color: Color = .accentColor
    /// How much of the ring the arc covers.
    var length: CGFloat = 0.28

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9
            Circle()
                .trim(from: 0, to: length)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(turn * 360))
                .padding(lineWidth / 2)
        }
    }
}

/// Trio's final answer under the fields: given (green), refused (red), carbs only (amber), no answer (amber). The
/// reason in a few words; Trio's full message under "Szczegóły z Trio".
struct BolusOutcomeCard: View {
    /// The loop the commands go to, by name (Trio, Loop).
    @Environment(\.loopSystem) private var loopSystem
    private var loop: LoopSystemNames { loopSystem.names }
    enum Tone { case given, refused, partial, unknown }
    let tone: Tone
    let title: String
    let subtitle: String
    let details: String?
    /// The time beside the title (given): the dose reads first, one line.
    var trailing: String? = nil
    var footnote: String? = nil
    @State private var showsDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: trailing == nil ? .top : .center, spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(tone == .given ? Color.white : color)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(tone == .given ? color : color.opacity(0.16)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(trailing == nil ? .subheadline.weight(.semibold) : .headline)
                        .foregroundStyle(tone == .given ? Color.primary : color)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(tone == .given ? Color.secondary : Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let footnote {
                        Text(footnote)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 2)
                    }
                }
                Spacer(minLength: 0)
                if let trailing {
                    Text(trailing)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            if let details {
                Button {
                    withAnimation(.snappy(duration: 0.25)) { showsDetails.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Text("Szczegóły z \(loop.genitive)")
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(showsDetails ? 180 : 0))
                    }
                    .font(.footnote.weight(.medium))
                }
                .buttonStyle(.borderless)
                .padding(.leading, 40)
                .accessibilityHint("Pełny komunikat \(loop.genitive)")
                if showsDetails {
                    Text(details)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(DashboardPalette.chipBackground))
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DashboardPalette.cardBackground))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(color.opacity(tone == .given ? 0.25 : 0.45), lineWidth: 1.5))
    }

    private var color: Color {
        switch tone {
        case .given: DashboardPalette.green
        case .refused, .partial: DashboardPalette.red
        case .unknown: DashboardPalette.yellow
        }
    }

    private var icon: String {
        switch tone {
        case .given: "checkmark"
        case .refused: "xmark"
        case .partial: "exclamationmark"
        case .unknown: "questionmark"
        }
    }
}

/// The slider while the command is on its way: the track filled, a light sweeping across it, and a spinner where the
/// knob stopped. Nothing to slide until Trio answers.
struct SlideProgressTrack: View {
    let title: String
    /// Trio's answer, for the moment before its card: the track in the answer's colour, its icon on the knob.
    var resolution: BolusSendSteps.Resolution? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let knob: CGFloat = 48

    var body: some View {
        // Dark text on yellow (white would not read).
        let textColor: Color = resolution == .unknown ? .black : .white
        ZStack(alignment: .trailing) {
            Capsule().fill(resolution?.color ?? Color.accentColor)
            if !reduceMotion, resolution == nil {
                TimelineView(.animation) { context in
                    let progress = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
                    GeometryReader { geometry in
                        let band = geometry.size.width * 0.35
                        LinearGradient(colors: [.clear, .white.opacity(0.22), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: band)
                            .offset(x: -band + (geometry.size.width + band) * progress)
                    }
                }
                .clipShape(Capsule())
            }
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(textColor)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .padding(.trailing, knob)
                .padding(.leading, 16)
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.2), value: title)
            Circle()
                .fill(.white)
                .frame(width: knob, height: knob)
                .overlay {
                    if let resolution {
                        Image(systemName: resolution.icon)
                            .font(.system(size: 20, weight: .heavy))
                            .foregroundStyle(resolution.color)
                            .transition(.scale(scale: 0.4).combined(with: .opacity))
                    } else {
                        SpinningArc(lineWidth: 3).padding(13)
                            .transition(.opacity)
                    }
                }
                .padding(4)
        }
        .frame(height: knob + 8)
        .animation(.snappy(duration: 0.3), value: resolution)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// One command in the history: state icon, amounts, time, what happened, and what can be done next.
struct RemoteCommandHistoryRow: View {
    let command: RemoteCommand
    let canRetry: Bool
    let onRetry: () -> Void
    let onOpenMeal: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: RemoteCommandStatusLabel.icon(command))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(RemoteCommandStatusLabel.color(command))
                .frame(width: 30, height: 30)
                .background(Circle().fill(RemoteCommandStatusLabel.color(command).opacity(0.15)))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(amounts).font(.subheadline.weight(.semibold))
                    Spacer()
                    if let date = ServerDate.parse(command.authorized_at) {
                        Text(RemoteCommandFormat.time(date)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Text(subtitle).font(.footnote).foregroundStyle(.secondary)
                if canRetry || onOpenMeal != nil {
                    HStack(spacing: 16) {
                        if canRetry {
                            Button(command.status == "PARTIAL" ? "Podaj sam bolus" : "Podaj ponownie", action: onRetry)
                        }
                        if let onOpenMeal {
                            Button("Otwórz posiłek", action: onOpenMeal)
                        }
                    }
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.borderless)
                    .padding(.top, 2)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var amounts: String {
        var parts: [String] = []
        if command.carbs_g > 0 { parts.append("\(command.carbs_g) g") }
        if command.insulin_u > 0 { parts.append("\(RemoteCommandFormat.units(command.insulin_u)) j") }
        return parts.joined(separator: " · ")
    }

    private var subtitle: String {
        var parts: [String] = [command.status_message ?? "Polecenie wysłane"]
        if let meal = command.meal_description { parts.append(meal) }
        switch command.source {
        case "CHAT_CARD": parts.append("z rozmowy")
        case "NEW_MEAL": parts.append("z nowego posiłku")
        case "WBT_SCREEN": parts.append("WBT z okna WBT")
        default: parts.append("z zakładki Bolus")
        }
        if !command.sent_by_me { parts.append("drugi opiekun") }
        return parts.joined(separator: " · ")
    }
}

/// A command's state as an icon and its text: waiting (clock), given (green check), refused (red x), no answer.
struct RemoteCommandStatusLabel: View {
    /// The loop the commands go to, by name (Trio, Loop).
    @Environment(\.loopSystem) private var loopSystem
    private var loop: LoopSystemNames { loopSystem.names }
    let command: RemoteCommand

    var body: some View {
        Label(command.status_message ?? "Polecenie wysłane, czekam na odpowiedź \(loop.genitive).", systemImage: Self.icon(command))
            .foregroundStyle(Self.color(command))
    }

    static func icon(_ command: RemoteCommand) -> String {
        if command.isSuccess { return "checkmark" }
        if command.isFailure { return "xmark" }
        if command.status == "NO_REPLY" { return "questionmark" }
        return "clock"
    }

    static func color(_ command: RemoteCommand) -> Color {
        if command.isSuccess { return .green }
        if command.isFailure { return .red }
        if command.status == "NO_REPLY" { return .orange }
        return .secondary
    }
}

/// W4 (variant B, 2026-10-19): the two amounts, tap one to change it on the keypad, the patient's data in one line, the
/// warnings, and a slider pinned at the bottom (harder to give insulin by accident than a button); Face ID follows.
struct RemoteBolusConfirmSheet: View {
    /// The loop the commands go to, by name (Trio, Loop).
    @Environment(\.loopSystem) private var loopSystem
    private var loop: LoopSystemNames { loopSystem.names }
    let confirmation: RemoteBolusConfirmation
    /// Who the dose is for, first on the sheet.
    var patientName: String? = nil
    /// This phone's limits for the amounts on the sheet (as they are typed).
    var limitProblem: (Int, Decimal) -> String? = { _, _ in nil }
    /// The confirmation was checked for the amounts typed last (RemoteBolusFlow.confirmationIsCurrent): the slider sends
    /// the confirmation's values, so it stays off while they differ from what was typed.
    var isCurrent = true
    /// Why the check of the typed amounts failed (shown in the sheet; the slider stays off).
    var checkError: String? = nil
    var onRecheck: () async -> Void = {}
    /// The DIY acknowledgement was accepted on this phone (RemoteBolusFlow.bolusAcknowledged): until then the sheet asks
    /// for it above the slider, which stays off.
    var acknowledged = true
    var onAcknowledge: () -> Void = {}
    let onConfirm: () -> Void
    let onCancel: () -> Void
    /// The caregiver changed the values: checked again (as they type) before the slider turns on (W7).
    let onUpdate: (Int, Decimal) async -> Void
    /// Changes when the low-glucose step closes without sending: the knob goes back to the left.
    var slideResetToken = 0

    private enum Field { case carbs, insulin }
    @State private var editing: Field?
    @State private var buffer = ""
    /// Typed but not checked yet: the slider waits for the check.
    @State private var pendingCheck = false
    @State private var checkTask: Task<Void, Never>?
    @State private var detent: PresentationDetent = .medium

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let patientName {
                        PatientBadge(name: patientName).padding(.bottom, 8)
                    }
                    if let description = confirmation.draftBase.meal?.description {
                        Text(description).font(.subheadline).foregroundStyle(.secondary).padding(.bottom, 6)
                    }
                    amountRow(.carbs, label: confirmation.draftBase.isRescue ? "Szybkie węglowodany" : "Węglowodany", value: editing == .carbs ? display(buffer) : String(confirmation.carbsG), unit: "g", accent: confirmation.draftBase.isRescue)
                    Divider()
                    // Rescue carbs go to Trio alone, as a hypo treatment: no insulin to set.
                    if !confirmation.draftBase.isRescue {
                        amountRow(.insulin, label: "Insulina", value: editing == .insulin ? display(buffer) : RemoteCommandFormat.units(confirmation.insulinU), unit: "j", accent: true)
                        Divider()
                    } else {
                        Text("\(loop.capitalized) zapisze je jako dosłodzenie z obecną godziną, bez insuliny i bez posiłku.")
                            .font(.footnote).foregroundStyle(.secondary).padding(.top, 6)
                    }
                    Text(hint).font(.footnote).foregroundStyle(.secondary).padding(.top, 6)
                    if let overLimit = currentLimitProblem {
                        Label(overLimit, systemImage: "xmark.octagon.fill").font(.footnote).foregroundStyle(.red).padding(.top, 6)
                    }
                    if let checkError, !pendingCheck {
                        VStack(alignment: .leading, spacing: 6) {
                            Label(checkError, systemImage: "exclamationmark.octagon.fill").font(.footnote).foregroundStyle(.red)
                            Button("Sprawdź ponownie") { recheck() }
                                .font(.footnote.weight(.semibold))
                                .buttonStyle(.borderless)
                        }
                        .padding(.top, 6)
                    }

                    if editing != nil {
                        NumericKeypad(allowsComma: editing == .insulin, onKey: type, onDone: { editing = nil })
                            .padding(.top, 12)
                    } else {
                        Text(contextLine).font(.footnote).foregroundStyle(.secondary).padding(.top, 14)
                        // Slid on data older than 2 min: they were read again and the caregiver slides again.
                        if let notice = confirmation.notice {
                            Label(notice, systemImage: confirmation.isRechecking ? "arrow.clockwise" : "info.circle")
                                .font(.footnote).foregroundStyle(.orange).padding(.top, 6)
                        }
                        ForEach(confirmation.preview.blocks.filter { $0.code != "INVALID_AMOUNTS" }, id: \.self) { block in
                            Label(block.message, systemImage: "xmark.octagon.fill").font(.footnote).foregroundStyle(.red).padding(.top, 6)
                        }
                        ForEach(confirmation.preview.warnings, id: \.self) { warning in
                            Label(warning.message, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange).padding(.top, 6)
                        }
                        // The chat card's own warnings (its forecast, fast carbs advised …), for the card's amounts.
                        let liveMessages = Set(confirmation.preview.warnings.map(\.message))
                        let cardWarnings = confirmation.draftBase.cardWarnings.filter { !liveMessages.contains($0.message) }
                        if !cardWarnings.isEmpty {
                            let sameAmounts = confirmation.draftBase.cardWarningsMatch(carbsG: confirmation.carbsG, insulinU: confirmation.insulinU)
                            Text(sameAmounts ? "Z karty w rozmowie" : "Z karty w rozmowie (dla dawki z karty, przed zmianą)")
                                .font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 10)
                            ForEach(cardWarnings, id: \.self) { warning in
                                Label(warning.message, systemImage: warning.isDanger ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                                    .font(.footnote).foregroundStyle(warning.isDanger ? .red : .orange).padding(.top, 4)
                            }
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
            }
            .navigationTitle(confirmation.draftBase.source == .wbtScreen ? "Podaj WBT" : confirmation.draftBase.isRescue ? "Dosłodzenie do \(loop.genitive)" : "Podaj bolus")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: onCancel) { Image(systemName: "xmark") }.accessibilityLabel("Zamknij")
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    DIYBolusAcknowledgementRow(acknowledged: acknowledged, onAcknowledge: onAcknowledge)
                    SlideToConfirm(
                        title: slideTitle,
                        subtitle: slideSubtitle,
                        isEnabled: confirmation.canConfirm && isChecked && hasAmount && currentLimitProblem == nil && acknowledged,
                        onConfirm: {
                            editing = nil
                            onConfirm()
                        }
                    )
                    .id(slideResetToken)
                    Button("Anuluj", action: onCancel).font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .padding(.bottom, 8)
                .background(.bar)
            }
        }
        // The keypad needs the whole height: the sheet grows when it opens.
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled()
    }

    private func amountRow(_ field: Field, label: String, value: String, unit: String, accent: Bool) -> some View {
        Button {
            editing = field
            withAnimation { detent = .large }
            buffer = field == .carbs
                ? (confirmation.carbsG > 0 ? String(confirmation.carbsG) : "")
                : (confirmation.insulinU > 0 ? RemoteCommandFormat.units(confirmation.insulinU) : "")
        } label: {
            HStack(alignment: .firstTextBaseline) {
                Text(label).foregroundStyle(.secondary)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(value)
                        .font(.system(size: 30, weight: .semibold, design: .rounded).monospacedDigit())
                    AmountUnit(unit: unit, size: 30, color: accent ? Color.accentColor : Color.primary)
                }
                .foregroundStyle(accent ? Color.accentColor : Color.primary)
                .padding(.bottom, 2)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(editing == field ? Color.accentColor : Color.secondary.opacity(0.4)).frame(height: editing == field ? 2 : 1)
                    }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label): \(value) \(unit). Stuknij, żeby zmienić")
    }

    private var hint: String {
        var parts = ["Stuknij liczbę, żeby zmienić"]
        if let fromICR = confirmation.preview.icr_insulin_u, confirmation.carbsG > 0 {
            parts.append("ICR: \(RemoteCommandFormat.units(fromICR)) j")
        }
        // "2,37" typed is sent as 2,35 (rounded down to the pump step): said before sliding.
        if editing == .insulin, isChecked, parsedInsulin(buffer) != confirmation.insulinU {
            parts.append("pompa poda \(RemoteCommandFormat.units(confirmation.insulinU)) j (krok pompy)")
        }
        return parts.joined(separator: " · ")
    }

    private var contextLine: String {
        let context = confirmation.preview.context
        var parts: [String] = []
        if let glucose = context.glucose {
            parts.append("\(Int(glucose.value)) mg/dL\(BolusGlucoseStrip.arrowCharacter(BolusGlucoseStrip.direction(glucose)).map { " \($0)" } ?? "")")
        } else {
            parts.append("brak odczytu glukozy")
        }
        if let iob = context.loop?.iob_units { parts.append("IOB \(RemoteCommandFormat.units(iob)) j") }
        if let cob = context.loop?.cob_grams { parts.append("COB \(Int(cob.rounded())) g") }
        return parts.joined(separator: " · ")
    }

    /// The amounts on screen (typed ones included) against this phone's limits.
    private var currentLimitProblem: String? {
        let insulin = editing == .insulin ? parsedInsulin(buffer) : confirmation.insulinU
        let carbs = editing == .carbs ? (Int(buffer) ?? 0) : confirmation.carbsG
        return limitProblem(carbs, insulin)
    }

    private var hasAmount: Bool {
        confirmation.carbsG > 0 || confirmation.insulinU > 0
    }

    /// The typed amounts were checked and the confirmation is for them (not a check on its way or a failed one).
    private var isChecked: Bool {
        !pendingCheck && isCurrent
    }

    /// What the slider sends: the checked confirmation (rounded to the pump step), never the keypad's buffer.
    private var slideTitle: String {
        if checkError != nil && !pendingCheck { return "Dawka niesprawdzona" }
        if !isChecked { return "Sprawdzam dawkę…" }
        if confirmation.insulinU > 0 { return "Przesuń, aby podać \(RemoteCommandFormat.units(confirmation.insulinU)) j" }
        if confirmation.carbsG > 0 { return "Przesuń, aby wysłać \(confirmation.carbsG) g" }
        return "Wpisz węglowodany lub insulinę"
    }

    private var slideSubtitle: String? {
        guard isChecked, checkError == nil || pendingCheck, confirmation.insulinU > 0 || confirmation.carbsG > 0 else { return nil }
        return PatientBadge.firstName(patientName).map { "dla: \($0)" }
    }

    private func recheck() {
        pendingCheck = true
        checkTask?.cancel()
        checkTask = Task {
            await onRecheck()
            guard !Task.isCancelled else { return }
            pendingCheck = false
        }
    }

    private func parsedInsulin(_ text: String) -> Decimal {
        let normalized = text.replacingOccurrences(of: ",", with: ".")
        return Decimal(string: normalized.isEmpty ? "0" : normalized, locale: Locale(identifier: "en_US_POSIX")) ?? 0
    }

    private func display(_ text: String) -> String {
        text.isEmpty ? "0" : text
    }

    private func type(_ key: NumericKeypad.Key) {
        switch key {
        case .digit(let digit):
            guard buffer.count < 6 else { return }
            if buffer == "0" { buffer = "" }
            if let comma = buffer.firstIndex(of: ","), buffer.distance(from: comma, to: buffer.endIndex) > 2 { return }
            buffer.append(String(digit))
        case .comma:
            guard !buffer.contains(",") else { return }
            buffer = (buffer.isEmpty ? "0" : buffer) + ","
        case .backspace:
            if !buffer.isEmpty { buffer.removeLast() }
        }
        scheduleCheck()
    }

    /// Each keystroke is checked a moment later (glucose, IOB, limits); the slider turns on when the check is back.
    private func scheduleCheck() {
        guard let field = editing else { return }
        pendingCheck = true
        checkTask?.cancel()
        let carbs = field == .carbs ? (Int(buffer) ?? 0) : confirmation.carbsG
        let insulin = field == .insulin ? parsedInsulin(buffer) : confirmation.insulinU
        checkTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await onUpdate(carbs, insulin)
            guard !Task.isCancelled else { return }
            pendingCheck = false
        }
    }
}

/// Digits, a comma (insulin only), backspace and "Gotowe", inside the sheet: the system keyboard would cover the slider.
struct NumericKeypad: View {
    enum Key { case digit(Int), comma, backspace }
    let allowsComma: Bool
    let onKey: (Key) -> Void
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            ForEach([[1, 2, 3], [4, 5, 6], [7, 8, 9]], id: \.self) { row in
                HStack(spacing: 8) {
                    ForEach(row, id: \.self) { digit in key(Text("\(digit)")) { onKey(.digit(digit)) } }
                }
            }
            HStack(spacing: 8) {
                key(Text(",")) { onKey(.comma) }.opacity(allowsComma ? 1 : 0).disabled(!allowsComma)
                key(Text("0")) { onKey(.digit(0)) }
                key(Image(systemName: "delete.left")) { onKey(.backspace) }.accessibilityLabel("Usuń")
            }
            Button(action: onDone) {
                Text("Gotowe").font(.headline).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func key<Label: View>(_ label: Label, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            label.font(.title2).frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.bordered)
        .tint(.secondary)
    }
}

/// Slide the knob to the end to confirm; it springs back otherwise. VoiceOver confirms with the default action.
struct SlideToConfirm: View {
    let title: String
    /// A smaller second line (who gets it); nil: one line.
    var subtitle: String? = nil
    let isEnabled: Bool
    /// Drawn as enabled or not (nil: as `isEnabled`): the Bolus tour keeps the slider's look while it is off.
    var looksEnabled: Bool? = nil
    let onConfirm: () -> Void
    @State private var offset: CGFloat = 0

    private let knob: CGFloat = 48

    var body: some View {
        let looks = looksEnabled ?? isEnabled
        return GeometryReader { geometry in
            let travel = max(0, geometry.size.width - knob - 8)
            ZStack(alignment: .leading) {
                Capsule().fill(looks ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.12))
                VStack(spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .opacity(0.8)
                    }
                }
                    .foregroundStyle(looks ? Color.accentColor : Color.secondary)
                    // One line each also beside the keyboard button (the slider is narrower then).
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.leading, knob)
                    .padding(.trailing, 12)
                    .opacity(travel > 0 ? 1 - Double(offset / travel) : 1)
                Circle()
                    .fill(looks ? Color.accentColor : Color.secondary.opacity(0.4))
                    .frame(width: knob, height: knob)
                    .overlay(Image(systemName: "chevron.right.2").foregroundStyle(.white).font(.headline))
                    .padding(4)
                    .offset(x: offset)
                    .gesture(
                        DragGesture()
                            .onChanged { value in
                                guard isEnabled else { return }
                                offset = min(max(0, value.translation.width), travel)
                            }
                            .onEnded { _ in
                                guard isEnabled else { return }
                                if offset >= travel * 0.9 {
                                    offset = travel
                                    onConfirm()
                                } else {
                                    withAnimation(.spring(response: 0.3)) { offset = 0 }
                                }
                            }
                    )
            }
        }
        .frame(height: knob + 8)
        // Turned off after a slide that did not send (the data are read again): the knob goes back to the left.
        .onChange(of: isEnabled) { _, enabled in
            if !enabled { withAnimation(.spring(response: 0.3)) { offset = 0 } }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if isEnabled { onConfirm() } }
    }
}

extension View {
    /// The separate step before insulin while glucose is below 70 or a low is near (dose-calculator.v1): the caregiver
    /// confirms it on its own, with a button that names what it does; cancelling sends nothing.
    /// A DANGER warning on the Bolus tab (dose above the data, the same meal twice …): its headline and full text, then
    /// "Podaj mimo to". The server still gets the warnings acknowledged as before; only this question is new (1.0.5).
    func dangerWarningsConfirmation(pending: Binding<[BolusCheckItem]?>, insulin: Decimal?, onConfirm: @escaping () -> Void) -> some View {
        let items = pending.wrappedValue ?? []
        return alert(
            items.first?.headline ?? "Ostrzeżenie",
            isPresented: Binding(get: { pending.wrappedValue != nil }, set: { if !$0 { pending.wrappedValue = nil } })
        ) {
            Button("Anuluj", role: .cancel) { pending.wrappedValue = nil }
            Button(insulin.map { "Podaj \(RemoteCommandFormat.units($0)) j mimo to" } ?? "Podaj mimo to", role: .destructive) {
                pending.wrappedValue = nil
                onConfirm()
            }
        } message: {
            Text(items.map(\.fullText).joined(separator: "\n\n"))
        }
    }

    func lowGlucoseInsulinConfirmation(isPresented: Binding<Bool>, insulin: Decimal?, onConfirm: @escaping () -> Void) -> some View {
        alert("Glukoza jest niska", isPresented: isPresented) {
            Button("Anuluj", role: .cancel) {}
            Button("Podaj insulinę mimo niskiej glukozy", role: .destructive, action: onConfirm)
        } message: {
            Text("Najpierw podaj węglowodany. Insulina teraz\(insulin.map { " (\(RemoteCommandFormat.units($0)) j)" } ?? "") pogłębi niedocukrzenie. Podaj ją tylko, jeśli na pewno tego chcesz.")
        }
    }

    /// Presents the confirmation of a remote command started from this screen and shows why one could not be opened.
    /// `onFinished(sent)` runs after [Podaj] (true when the push left the phone).
    func remoteBolusConfirmation(flow: RemoteBolusFlow, showsFailureAlert: Bool = false, onFinished: @escaping (Bool) -> Void = { _ in }) -> some View {
        modifier(RemoteBolusConfirmationHost(flow: flow, showsFailureAlert: showsFailureAlert, onFinished: onFinished))
    }
}

/// The DIY acknowledgement in a bolus confirmation: a required switch until it is accepted on this phone, then only the
/// notice (DIYAcknowledgement).
struct DIYBolusAcknowledgementRow: View {
    let acknowledged: Bool
    let onAcknowledge: () -> Void
    /// Switched on in this confirmation: it stays on screen (on) instead of disappearing under the finger.
    @State private var acceptedHere = false

    var body: some View {
        if acknowledged && !acceptedHere {
            Text(DIYAcknowledgement.notice)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("diy.bolusNotice")
        } else {
            Toggle(isOn: Binding(get: { acceptedHere || acknowledged }, set: { on in
                guard on, !acknowledged else { return }
                acceptedHere = true
                onAcknowledge()
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(DIYAcknowledgement.acceptTitle).font(.subheadline.weight(.semibold))
                    Text(DIYAcknowledgement.notice).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(Brand.interactive)
            .disabled(acceptedHere)
            .accessibilityIdentifier("diy.bolusAccept")
        }
    }
}

private struct RemoteBolusConfirmationHost: ViewModifier {
    @ObservedObject var flow: RemoteBolusFlow
    let showsFailureAlert: Bool
    let onFinished: (Bool) -> Void
    /// Insulin while glucose is below 70 or a low is near: asked separately before Face ID.
    @State private var asksLowGlucose = false
    @State private var lowStepClosed = 0

    private func send(lowGlucoseConfirmed: Bool) {
        Task {
            await flow.confirm(lowGlucoseConfirmed: lowGlucoseConfirmed)
            if case .sent = flow.state { onFinished(true) } else { onFinished(false) }
        }
    }

    private var failure: String? {
        if case let .failed(message) = flow.state { return message }
        return nil
    }

    func body(content: Content) -> some View {
        content
            // Screens without a status row (the chat) say why nothing was sent.
            .alert("Nie wysłano", isPresented: Binding(get: { showsFailureAlert && failure != nil }, set: { if !$0 { flow.reset() } })) {
                Button("OK", role: .cancel) { flow.reset() }
            } message: {
                Text(failure ?? "")
            }
            .sheet(isPresented: Binding(get: { flow.confirmation != nil }, set: { if !$0 { flow.cancel() } })) {
                if let confirmation = flow.confirmation {
                    RemoteBolusConfirmSheet(
                        confirmation: confirmation,
                        patientName: flow.patientName,
                        limitProblem: { carbs, insulin in flow.limitProblem(carbsG: carbs, insulinU: insulin) },
                        isCurrent: flow.confirmationIsCurrent,
                        checkError: flow.checkError,
                        onRecheck: { await flow.recheck() },
                        acknowledged: flow.bolusAcknowledged,
                        onAcknowledge: { flow.acceptBolusAcknowledgement() },
                        onConfirm: {
                            if flow.confirmationNeedsLowGlucoseStep {
                                asksLowGlucose = true
                            } else {
                                send(lowGlucoseConfirmed: false)
                            }
                        },
                        onCancel: { flow.cancel() },
                        onUpdate: { carbs, insulin in await flow.update(carbsG: carbs, insulinU: insulin) },
                        slideResetToken: lowStepClosed
                    )
                    .lowGlucoseInsulinConfirmation(isPresented: $asksLowGlucose, insulin: confirmation.insulinU) {
                        send(lowGlucoseConfirmed: true)
                    }
                }
            }
            .onChange(of: asksLowGlucose) { _, open in
                if !open { lowStepClosed += 1 }
            }
            // An open confirmation closes for a notification; a command being sent is never interrupted (the app
            // waits with the notification's screen until it is sent, see AppContainer.open).
            .closesForNotification(isPresented: flow.confirmation != nil) {
                if flow.state != .sending { flow.cancel() }
            }
    }
}

/// Who a dose is for: on the confirmation and the Bolus tab, so a caregiver of several patients never gives it to the
/// wrong one.
struct PatientBadge: View {
    let name: String

    /// "Franciszek" from "Franciszek Długonazwiskowy": short enough for the slider.
    static func firstName(_ name: String?) -> String? {
        name?.split(separator: " ").first.map(String.init)
    }

    var body: some View {
        Label {
            Text(name).fontWeight(.semibold)
        } icon: {
            Image(systemName: "person.crop.circle.fill")
        }
        .font(.subheadline)
        .foregroundStyle(.tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color.accentColor.opacity(0.14)))
        .accessibilityLabel("Pacjent: \(name)")
    }
}

/// The unit after an amount ("g", "j") in a box of one width, so the carbs and the insulin end at the same place one
/// above the other whatever the letter.
struct AmountUnit: View {
    let unit: String
    let size: CGFloat
    let color: Color

    var body: some View {
        Text(unit)
            .font(.system(size: size, weight: .semibold, design: .rounded))
            .foregroundStyle(color)
            .frame(width: size * 0.62, alignment: .leading)
    }
}


/// A chip's label: its icon with the title (or the icon alone).
struct BellChipLabelStyle: LabelStyle {
    let showsTitle: Bool

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            if showsTitle { configuration.title }
        }
    }
}

/// "Masz wątpliwości co do dawki?   💬 Zapytaj w czacie": one quiet row, the whole of it tappable; the bubble sits with
/// the action, so it reads as the button. On a narrow phone the question shortens, the action never does.
struct AskInChatRow: View {
    var compact = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                ViewThatFits(in: .horizontal) {
                    Text("Masz wątpliwości co do dawki?")
                    Text("Masz wątpliwości?")
                    Text("Wątpliwości?")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                Spacer(minLength: 6)
                Label("Zapytaj w czacie", systemImage: "bubble.left.fill")
                    .labelStyle(BellChipLabelStyle(showsTitle: true))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .fixedSize()
            }
            .padding(.horizontal, 12)
            .frame(height: compact ? 32 : 40)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(DashboardPalette.cardBackground))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Zapytaj w czacie")
        .accessibilityHint("Otwiera nową rozmowę")
    }
}

/// The insulin field's corner switch (it replaced the ± button): two small buttons glued into one rounded rectangle,
/// the calculator on top, "ICR" below. The segment of the dose in the field is filled (white on Brand.interactive), the
/// other light; with a typed dose neither. A tap anywhere switches to the other source (with a typed dose: the tapped
/// one). One VoiceOver element, "Źródło dawki", adjustable.
struct DoseSourceSwitch: View {
    let state: RemoteBolusViewModel.DoseSwitchState
    /// A picture only (the Bolus tour's sample): no taps, no actions.
    var isSample = false
    let onTap: (RemoteBolusViewModel.DoseSwitchSegment?) -> Void

    @ScaledMetric(relativeTo: .caption) private var scaledWidth: CGFloat = 28
    @ScaledMetric(relativeTo: .caption) private var scaledSegment: CGFloat = 20

    var body: some View {
        // Grows with the text size, but only so far: the tile's header keeps room for "Insulina".
        let w = min(scaledWidth, 34)
        let h = min(scaledSegment, 25)
        let padX = max(0, (44 - w) / 2)
        let padY = max(0, (44 - (2 * h + 1)) / 2)
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        return VStack(spacing: 0) {
            segment(.calculator, height: h) {
                Image(systemName: "plus.forwardslash.minus")
                    .font(.system(size: min(h * 0.55, 13), weight: .semibold))
            }
            Rectangle()
                .fill(Brand.interactive.opacity(0.35))
                .frame(height: 1)
            segment(.icr, height: h) {
                Text("ICR")
                    .font(.system(size: min(h * 0.45, 11), weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .frame(width: w)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Brand.interactive.opacity(0.45), lineWidth: 1))
        // A finger-sized target (44 pt) around the small switch: its upper half is the calculator, the lower "ICR".
        .padding(.horizontal, padX)
        .padding(.vertical, padY)
        .contentShape(Rectangle())
        .onTapGesture(coordinateSpace: .local) { location in
            onTap(location.y < padY + h + 0.5 ? .calculator : .icr)
        }
        .padding(.horizontal, -padX)
        .padding(.vertical, -padY)
        .fixedSize()
        .allowsHitTesting(!isSample)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Źródło dawki")
        .accessibilityValue(state.accessibilityValue)
        .accessibilityHint(isSample ? "" : state.addsCorrection ? "Kalkulator dokłada połowę wyliczonej korekty, najwyżej 1 j" : "Kalkulator albo przelicznik (ICR)")
        .accessibilityAdjustableAction { _ in if !isSample { onTap(nil) } }
        .accessibilityAction { if !isSample { onTap(nil) } }
        .accessibilityIdentifier("bolus.doseSource")
    }

    private func segment<Content: View>(_ segment: RemoteBolusViewModel.DoseSwitchSegment, height: CGFloat, @ViewBuilder content: () -> Content) -> some View {
        let selected = state.selected == segment
        return content()
            .foregroundStyle(selected ? Color.white : Brand.interactive)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(selected ? Brand.interactive : Brand.interactive.opacity(0.12))
    }
}

/// "Zapisz jako posiłek" above the slider once carbs are typed: the dose becomes a meal of the Meals journal. A set
/// reminder ticks it and holds it (it belongs to the meal); the chat is the round button at the end.
struct SaveAsMealRow: View {
    @Binding var isOn: Bool
    var locked = false
    var compact = false
    let onAskInChat: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            Button {
                guard !locked else { return }
                withAnimation(.snappy(duration: 0.2)) { isOn.toggle() }
            } label: {
                HStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isOn ? Color.accentColor : Color.clear)
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(isOn ? Color.accentColor : Color.secondary.opacity(0.5), lineWidth: 1.5)
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.white)
                            .scaleEffect(isOn ? 1 : 0.4)
                            .opacity(isOn ? 1 : 0)
                    }
                    .frame(width: 22, height: 22)
                    Text("Zapisz jako posiłek")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.selection, trigger: isOn)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Zapisz jako posiłek")
            .accessibilityValue(isOn ? "zaznaczone" : "niezaznaczone")
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(locked ? "Zaznaczone, bo jest ustawione przypomnienie" : "Dawka pojawi się w Posiłkach")

            if let onAskInChat {
                Button(action: onAskInChat) {
                    Image(systemName: "bubble.left.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: compact ? 26 : 30, height: compact ? 26 : 30)
                        .background(Circle().fill(Color.accentColor.opacity(0.12)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Zapytaj w czacie")
                .accessibilityHint("Otwiera nową rozmowę")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(height: compact ? 32 : 40)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(DashboardPalette.cardBackground))
    }
}

enum BolusReminderStyle {
    static let tint = Color(red: 0.557, green: 0.361, blue: 0.969)
}

/// "Przypomnij mi": three ready-made reminders, several at once. They only remind: at the reminder the caregiver decides
/// the dose (the WBT one is computed when the meal has a description).
struct BolusReminderSheet: View {
    @Binding var plan: BolusReminderPlan
    let glucoseRisingNow: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var customMinutes = 45
    @State private var showsCustom = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Można zaznaczyć więcej niż jedno.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    row(
                        icon: "W", color: .green, title: "WBT za 2,5 h",
                        detail: "ok. \(BolusReminderPlan.clock(Date().addingTimeInterval(TimeInterval(BolusReminderPlan.wbtMinutes * 60)), calendar: .current))",
                        isOn: plan.wbt
                    ) { plan.wbt.toggle() }
                    row(
                        icon: "arrow.up.right", color: .accentColor, title: "Druga dawka, gdy glukoza zacznie rosnąć",
                        detail: glucoseRisingNow
                            ? "Glukoza już rośnie od 10 min. Możesz podać teraz."
                            : "w ciągu 1 h · gdy nie wzrośnie, przypomnienie wygaśnie",
                        isOn: plan.secondDose == .whenRising
                    ) { plan.secondDose = plan.secondDose == .whenRising ? nil : .whenRising }
                    timedRow
                }
                .padding(16)
            }
            .navigationTitle("Przypomnij mi")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Gotowe") { dismiss() }
                }
                if !plan.isEmpty {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Wyczyść") { plan = BolusReminderPlan() }
                    }
                }
            }
        }
        .onAppear {
            if case let .after(minutes)? = plan.secondDose, !BolusReminderPlan.presetMinutes.contains(minutes) {
                customMinutes = minutes
                showsCustom = true
            }
        }
    }

    private var selectedMinutes: Int? {
        if case let .after(minutes)? = plan.secondDose { return minutes }
        return nil
    }

    private var timedRow: some View {
        let on = selectedMinutes != nil
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                plan.secondDose = on ? nil : .after(minutes: showsCustom ? customMinutes : 30)
            } label: {
                rowLabel(
                    icon: "timer", color: .gray, title: "Druga dawka za zadany czas",
                    detail: selectedMinutes.map { "o \(BolusReminderPlan.clock(Date().addingTimeInterval(TimeInterval($0 * 60)), calendar: .current))" } ?? "15 min, 30 min, 1 h albo inny",
                    isOn: on
                )
            }
            .buttonStyle(.plain)
            if on {
                HStack(spacing: 8) {
                    ForEach(BolusReminderPlan.presetMinutes, id: \.self) { minutes in
                        timeChip(minutes == 60 ? "1 h" : "\(minutes) min", selected: !showsCustom && selectedMinutes == minutes) {
                            showsCustom = false
                            plan.secondDose = .after(minutes: minutes)
                        }
                    }
                    timeChip("Inny", selected: showsCustom) {
                        showsCustom = true
                        plan.secondDose = .after(minutes: customMinutes)
                    }
                }
                .padding(.leading, 44)
                if showsCustom {
                    Stepper(value: $customMinutes, in: BolusReminderPlan.customMinutesRange, step: 5) {
                        Text("za \(customMinutes) min").monospacedDigit()
                    }
                    .padding(.leading, 44)
                    .onChange(of: customMinutes) { _, minutes in plan.secondDose = .after(minutes: minutes) }
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(on ? BolusReminderStyle.tint.opacity(0.12) : DashboardPalette.chipBackground))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(on ? BolusReminderStyle.tint : Color.clear, lineWidth: 1.5))
    }

    private func row(icon: String, color: Color, title: String, detail: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            rowLabel(icon: icon, color: color, title: title, detail: detail, isOn: isOn)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(isOn ? BolusReminderStyle.tint.opacity(0.12) : DashboardPalette.chipBackground))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(isOn ? BolusReminderStyle.tint : Color.clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    private func rowLabel(icon: String, color: Color, title: String, detail: String, isOn: Bool) -> some View {
        HStack(spacing: 12) {
            Group {
                if icon.count == 1 {
                    Text(icon).font(.subheadline.weight(.bold))
                } else {
                    Image(systemName: icon).font(.subheadline.weight(.semibold))
                }
            }
            .foregroundStyle(.white)
            .frame(width: 32, height: 32)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(color))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(isOn ? BolusReminderStyle.tint : Color.secondary.opacity(0.5))
        }
        .contentShape(Rectangle())
    }

    private func timeChip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Capsule().fill(selected ? BolusReminderStyle.tint : DashboardPalette.chipBackground))
                .foregroundStyle(selected ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
    }
}
