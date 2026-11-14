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
    @Environment(\.predictionLineOn) private var predictionOn
    private var loop: LoopSystemNames { loopSystem.names }
    @StateObject private var viewModel: RemoteBolusViewModel
    /// "Prognoza glukozy": what is planned, for the chart.
    @StateObject private var predictionPlan: PredictionLineModel
    @Environment(\.liveUpdates) private var liveUpdates
    let trailingControls: AnyView
    /// The other patients, offered in a bubble under the name.
    let patientChoices: PatientChoices
    /// "Zapytaj w czacie": a new, empty conversation (nil: no chat to open).
    /// Grams from a planned meal's page: typed in once, the dose and its checks are this tab's own.
    var prefillCarbs: Int? = nil
    var prefillInsulin: Double? = nil
    var onPrefillUsed: () -> Void = {}
    let onAskInChat: (() -> Void)?
    let onOpenMeal: (String) -> Void
    /// The meal chat behind "Opisz posiłek" on the given card (nil: no button).
    let mealChatAPI: MealChatAPI?
    /// "Opisz posiłek": the meal's chat in a sheet.
    @State private var describeMealRoute: MealRoute?
    /// "Do posiłku: …" (meal-attach.v1): the bigger earlier meal the given dose may join, and the join (nil: no button).
    let mealAttachAPI: MealAttachAPI?
    /// "Do posiłku: <planned meal>" (nil: no button).
    var plannedMealAPI: APIClient? { mealAttachAPI as? APIClient }
    @StateObject private var mealAttach = BolusMealAttachModel()
    /// "Dopisać do posiłku?" asked in the card before the join (the dose's own meal is gone after it).
    @State private var confirmsAttach = false
    /// After a given bolus "Masz wątpliwości co do dawki?" makes way for the card; back on a tap in the carbs or
    /// insulin field, or when the screen is opened again.
    @State private var askHiddenAfterGiven = false
    /// The Bolus tour (BolusTour): whose "seen" mark, what else is on screen, and the requests from Ustawienia.
    let tourHost: BolusTourHost

    private enum Field: Hashable { case carbs, insulin }
    private enum Segment: Hashable { case give, history }
    @Environment(\.scenePhase) private var scenePhase
    @State private var segment: Segment = .give
    /// v4: the history, the warnings' list (from the chart's status line) in sheets.
    @State private var showsHistory = false
    @State private var showsChecks = false
    /// The finger is on the slider (the question before sending holds the dose as well).
    @State private var sliderTouched = false
    /// The same pull as on "Teraz" and in the meals: the ring in the gap, the content goes back at once.
    @State private var pull = PullModel()
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
    /// The chart's height without the keyboard: lower while the given card's buttons and question would not fit above
    /// the slider, so the screen does not scroll (back to its full height when the card shrinks).
    @State private var restChartHeight: CGFloat = 142
    /// The tab's layout has settled after it appeared: only then may the chart give way (fitted on the first frames'
    /// heights it jumped and overlapped the fields).
    @State private var layoutSettled = false
    /// 142 since the dose segment and the reserved line under the chart (2026-11-14): the warnings row stays above the slider on a 6.3" phone.
    private static let restChartRange: ClosedRange<CGFloat> = 110...142
    /// The chart and the fields are animating to a fitted height (see fitCompactChart).
    @State private var fitAnimating = false
    /// The keyboard has finished coming up: only then are the chart and the fields fitted (fitted mid-way, the fields
    /// first grew too tall and shrank back a moment later; owner 2026-11-14).
    @State private var keyboardSettled = false
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
    /// One "calculating" state (bolus screen review 2026-11-14): the dose, the chart and the slider wait together; after
    /// 4 s the slider says the check takes longer than usual.
    @State private var calculatingLong = false
    /// The last lines under the dose and the last checks' row, kept (dimmed) while the next check is on its way: nothing
    /// under the fields disappears and comes back, nothing changes height.
    @State private var lastCalculatorLine: String?
    @State private var lastICRLine: String?
    @State private var lastChecks: BolusCheckSummary?
    /// The carbs the kept row was for: it stands in only while the same carbs are recalculated (owner 2026-11-14: a red
    /// row of cleared carbs came back for a moment under a new dose).
    @State private var lastChecksCarbs: Int?
    /// What the chart gets of the room left on a tall phone (measured once, never changed by warnings or cards).
    @State private var restChartBonus: CGFloat = 0
    @State private var restChartBonusMeasured = false
    /// The chart's forecast with the dose that was just sent: its dashed line stays until the loop's next forecast.
    @State private var sentForecast: BolusForecastChart?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    /// While typing the chart takes the room left above the keyboard (the fields keep their height; up to 200).
    private static let compactChartRange: ClosedRange<CGFloat> = 44...200

    init(
        predictionAPI: PredictionLineAPI,
        predictionPatientID: String,
        viewModel: @autoclosure @escaping () -> RemoteBolusViewModel,
        trailingControls: AnyView,
        patientChoices: PatientChoices = PatientChoices(),
        prefillCarbs: Int? = nil,
        prefillInsulin: Double? = nil,
        onPrefillUsed: @escaping () -> Void = {},
        onAskInChat: (() -> Void)? = nil,
        onOpenMeal: @escaping (String) -> Void,
        mealChatAPI: MealChatAPI? = nil,
        mealAttachAPI: MealAttachAPI? = nil,
        tourHost: BolusTourHost
    ) {
        self.prefillCarbs = prefillCarbs
        self.prefillInsulin = prefillInsulin
        self.onPrefillUsed = onPrefillUsed
        self.onAskInChat = onAskInChat
        self.mealChatAPI = mealChatAPI
        self.mealAttachAPI = mealAttachAPI
        self.tourHost = tourHost
        _tourController = ObservedObject(wrappedValue: tourHost.controller)
        _predictionPlan = StateObject(wrappedValue: PredictionLineModel(api: predictionAPI, patientID: predictionPatientID))
        _viewModel = StateObject(wrappedValue: viewModel())
        self.trailingControls = trailingControls
        self.patientChoices = patientChoices
        self.onOpenMeal = onOpenMeal
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // v4 (owner 2026-11-14): one screen; the history, the chat and the guide are icons in the top bar.
                giveView
            }
                // VoiceOver keeps to the tour's callout while it is on.
                .accessibilityHidden(tour?.isActive == true)
                .background(DashboardPalette.pageBackground)
                .onChange(of: tourStage.isSample, initial: true) { _, sample in tourController.sampleStep = sample }
                // The tour's buttons sit where the keyboard comes up: no field takes the cursor while it runs (owner
                // 2026-11-14: a tap on the carbs or a late autofocus hid "Dalej" under the keyboard, the tour was stuck).
                .onChange(of: focused) { _, field in
                    if field != nil, tour?.isActive == true { focused = nil }
                }
                .onChange(of: tour?.isActive == true) { _, active in
                    if active { focused = nil }
                }
                // "Przypomnij" presents from here, not from its chip: the chip is drawn in each of the hints' layouts
                // (ViewThatFits), and a layout switch while the sheet is open (the keyboard going down) dismissed it.
                .sheet(isPresented: $showsReminders, onDismiss: {
                    // Back to typing where it was; without a field typed in, the usual layout comes back.
                    if let field = focusBeforeReminders {
                        focused = field
                    } else if self.compact {
                        withAnimation(Self.layoutCurve) { self.compact = false }
                    }
                    focusBeforeReminders = nil
                }) {
                    BolusReminderSheet(plan: $viewModel.reminderPlan, glucoseRisingNow: viewModel.glucoseRisingNow, glucoseFallingNow: viewModel.glucoseFallingNow)
                        // One height from the start (it jumped between two while opening).
                        .presentationDetents([.medium])
                }
                .sheet(isPresented: $showsHistory) {
                    NavigationStack {
                        historyView
                            .navigationTitle("Historia")
                            #if os(iOS)
                            .navigationBarTitleDisplayMode(.inline)
                            #endif
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Gotowe") { showsHistory = false } } }
                    }
                }
                .sheet(isPresented: $showsChecks) {
                    NavigationStack {
                        ScrollView {
                            BolusChecksRow(summary: displayedChecks, expanded: .constant(true))
                                .padding(16)
                        }
                        .navigationTitle("Ostrzeżenia")
                        #if os(iOS)
                        .navigationBarTitleDisplayMode(.inline)
                        #endif
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Gotowe") { showsChecks = false } } }
                    }
                    .presentationDetents([.medium, .large])
                }
                .sheet(item: $describeMealRoute, onDismiss: { refreshGivenMeal() }) { route in
                    if let mealChatAPI {
                        MealChatView(route: route, api: mealChatAPI, closesAfterAccept: true) { describeMealRoute = nil }
                    }
                }
                .closesForNotification(isPresented: describeMealRoute != nil) { describeMealRoute = nil }
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
                            PatientTitle(name: patientName, choices: patientChoices, extraTrailingWidth: 50)
                        }
                    }
                    #endif
                    // One item: as two, iOS folded the bell and the gear into a "•••" overflow menu.
                    ToolbarItem(placement: .primaryAction) {
                        HStack(spacing: 4) {
                            headerIcons
                            trailingControls
                        }
                    }
                }
                .onChange(of: prefillCarbs) { _, grams in
                    guard let grams else { return }
                    viewModel.carbsText = String(grams)
                    if let prefillInsulin { viewModel.insulinText = RemoteCommandFormat.units(prefillInsulin) }
                    onPrefillUsed()
                }
                .task {
                    viewModel.bindLiveUpdates(liveUpdates)
                    await viewModel.load()
                    if let prefillCarbs {
                        viewModel.carbsText = String(prefillCarbs)
                        if let prefillInsulin { viewModel.insulinText = RemoteCommandFormat.units(prefillInsulin) }
                        onPrefillUsed()
                    }
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
                    viewModel.stopRetrying()
                }
                // Back from the lock screen or another app: the chart and the checks are read at once, not at the next minute.
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active, segment == .give else { return }
                    Task { await viewModel.refreshAll() }
                }
                // Once per person on this phone: when the tab is first opened, as soon as nothing else is on screen.
                .task { await autoStartTour() }
                .onChange(of: tourHost.request) { _, _ in requestTour(after: 700_000_000) }
                // A command on its way (from another phone, a notification's action) ends the tour.
                .onChange(of: viewModel.isLocked) { _, locked in if locked { interruptTour() } }
                .onDisappear { interruptTour() }
        }
    }

    /// v4 top bar: the history, the chat and the guide (they were the "Podaj / Historia" switch, "?" and a row above
    /// the slider).
    private var headerIcons: some View {
        HStack(spacing: 2) {
            headerIcon("clock.arrow.circlepath", label: "Historia poleceń") { showsHistory = true }
                .tourAnchor(.modeSwitch)
            headerIcon("questionmark.circle", label: "Przewodnik po ekranie Bolus") { requestTour() }
                .accessibilityIdentifier("bolus.tour.open")
        }
    }

    private func headerIcon(_ name: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.body)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: Przewodnik

    /// What the tab draws as a sample for the current step (the alarm clock, the switch, the warnings row).
    private var tourStage: BolusTourStage {
        BolusTour.stage(tour: tour, realRemindersShown: true, realDoseSourceShown: viewModel.doseSwitch != nil, realChecksShown: !checkSummary.isEmpty)
    }

    private var tourConditions: BolusTour.StartConditions {
        BolusTour.StartConditions(
            setupGuideShowing: tourHost.setupGuideShowing(),
            modalShowing: tourHost.modalShowing() || showsReminders || pendingDangerConfirmation != nil || viewModel.pendingLowGlucoseConfirmation,
            keyboardVisible: focused != nil || compact,
            sendInFlight: viewModel.isLocked || viewModel.flow.state == .sending || viewModel.flow.state == .checking || viewModel.waitingUntil != nil || viewModel.flow.retryAt != nil,
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
        // After "Gotowe" or "Pomiń" the screen is as on any other opening: the cursor in the carbs.
        if outcome == .completed || outcome == .skipped, !viewModel.isLocked, viewModel.outcome == nil, viewModel.retry == nil {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 300_000_000)
                if tour == nil, focused == nil { focused = .carbs }
            }
        }
    }

    /// The tour has not been seen on this phone yet (it starts by itself once the screen settles): the keyboard stays
    /// down on opening, or it would cover the tour and hold it back (owner 2026-11-14). Not known who is signed in yet:
    /// treated as still to come.
    private var tourStillToCome: Bool {
        guard tourHost.autoStartAllowed else { return false }
        guard let key = tourHost.key() else { return true }
        return SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: key, store: Self.tourStore)
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
            VStack(alignment: .leading, spacing: compact ? 8 : 10) {
                if let error = viewModel.previewError {
                    Label(error, systemImage: "wifi.exclamationmark").font(.footnote).foregroundStyle(.red)
                }
                // A retry started from the history (Trio's own answer on this screen has its card below instead).
                if let retry = viewModel.retry, viewModel.outcome == nil, !viewModel.isLocked {
                    retryBanner(retry)
                }

                // v4: the glucose, IOB and COB in the chart card's header, the warnings as its status line; one height
                // with or without the keyboard.
                BolusForecastCard(
                    readings: viewModel.readings,
                    forecast: viewModel.preview?.forecast,
                    hasGlucose: viewModel.preview?.context.glucose != nil,
                    updating: viewModel.chartIsUpdating,
                    loading: viewModel.chartIsLoading,
                    compact: true,
                    compactChartHeight: Self.chartHeight,
                    chartHeight: Self.chartHeight,
                    context: viewModel.shownContext(now: Date()),
                    plan: predictionOn ? predictionPlan.line : nil,
                    afterBolus: awaitingLoopAfterBolus,
                    afterBolusForecast: awaitingLoopAfterBolus ? sentForecast : nil,
                    afterBolusSince: awaitingLoopAfterBolusSince,
                    status: AnyView(chartStatusLine)
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
                    amountField(.insulin, label: "Insulina", note: insulinSource, icon: "drop.fill", text: $viewModel.insulinText, unit: "j", tint: .accentColor, inTrio: nil) {
                        if !showsOutcome { doseSwap }
                    }
                    .tourAnchor(.insulin)
                }
                .fixedSize(horizontal: false, vertical: true)
                .id("bolus.tour.fields")

                // Both doses in one wide bar under the tiles (owner 2026-11-14, layout B): a thumb's reach, each with its
                // reason; one fixed height whatever it shows, so the slider never moves.

                if showsOutcome {
                    // One card at a time in one place: the steps fade out before Trio's answer fades in (they overlapped).
                    ZStack(alignment: .top) {
                        outcomeCard
                            .id(outcomeCardIdentity)
                            .transition(.asymmetric(
                                insertion: .opacity.animation(.easeOut(duration: 0.2).delay(0.12)),
                                removal: .opacity.animation(.easeIn(duration: 0.12))
                            ))
                    }
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
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
                fitRestChart()
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { top in
            scrollTop = top
            fitCompactChart()
            fitRestChart()
        }
        .scrollDismissesKeyboard(.interactively)
        // Pull down: the chart, the checks and the history read again, as on "Teraz".
        .modifier(ListPullToRefresh(pull: pull) { await viewModel.refreshAll() })
        // No keyboard toolbar ("Gotowe"): iOS counted it into the keyboard's height differently for the number pad and
        // the decimal pad, so the slider sat higher for the insulin than for the carbs. The bar's own button hides it.
        .onChange(of: focused) { _, field in
            if field != nil { askHiddenAfterGiven = false }
            guard !showsReminders, (field != nil) != compact else { return }
            withAnimation(Self.layoutCurve) { compact = field != nil }
        }
        // The bar's own button beside the slider hides the keyboard here.
        .hidesKeyboardDismissButton(compact)
        .task(id: compact) {
            keyboardSettled = false
            guard compact else { return }
            // The keyboard's own animation is ~0.35 s: fitted once it has stopped, in one move.
            try? await Task.sleep(nanoseconds: 420_000_000)
            guard !Task.isCancelled else { return }
            keyboardSettled = true
            fitCompactChart()
        }
        .onChange(of: compact) { _, compact in
            if !compact && fieldsExtraHeight != 0 {
                withAnimation(Self.layoutCurve) { fieldsExtraHeight = 0 }
            }
        }
        // Where the screen is too short for everything above the keyboard (a larger text size, a taller keyboard), the
        // hints are scrolled into view once the keyboard is up; the glucose goes under the top bar then.
        // v4: no second scroll after the keyboard is up (owner 2026-11-14: the screen moved up in two steps); the
        // layout fits above the keyboard and iOS keeps the field typed in visible with the keyboard's own animation.
        .onChange(of: viewModel.isLocked) { _, locked in
            if locked { focused = nil }
        }
        // One "calculating" state: after 4 s without the check's answer the slider says it takes longer than usual.
        .task(id: viewModel.isCalculating) {
            calculatingLong = false
            guard viewModel.isCalculating else { return }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, viewModel.isCalculating else { return }
            withAnimation(.easeOut(duration: 0.2)) { calculatingLong = true }
        }
        // The lines under the dose and the checks' row stay (dimmed) while the next check is on its way.
        .onChange(of: viewModel.calculatorLine, initial: true) { _, line in
            if let line { lastCalculatorLine = line } else if !viewModel.isCalculating { lastCalculatorLine = nil }
        }
        .onChange(of: viewModel.icrLine, initial: true) { _, line in
            if let line { lastICRLine = line } else if !viewModel.isCalculating { lastICRLine = nil }
        }
        .onChange(of: viewModel.isCalculating) { _, calculating in
            guard !calculating else { return }
            lastCalculatorLine = viewModel.calculatorLine
            lastICRLine = viewModel.icrLine
        }
        // A red row appearing (a low, a dose above the data) is scrolled into view on a short phone: it is never under
        // the slider while the slider says "mimo spadku".
        .onChange(of: checkSummary.headline?.isRed == true) { _, red in
            guard red, !compact else { return }
            withAnimation(.snappy(duration: 0.3)) { scroll.scrollTo(Self.contentEndID, anchor: .bottom) }
        }
        // A new card under the fields (the steps, Trio's answer) is scrolled into view: the chart keeps its height.
        .onChange(of: outcomeKey) { _, _ in
            guard showsOutcome else { return }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 350_000_000)
                withAnimation(.snappy(duration: 0.3)) { scroll.scrollTo(Self.contentEndID, anchor: .bottom) }
            }
        }
        // "Dopisać do posiłku?" grows the given card: its buttons come up above the slider.
        // A new bolus (sent, refused, given): the last one's meal and question are not this one's.
        .onChange(of: viewModel.outcome?.command.id) { _, id in
            mealAttach.follow(commandID: id)
            confirmsAttach = false
        }
        .onChange(of: confirmsAttach) { _, asking in
            guard asking else { return }
            withAnimation(BolusMealAttachModel.change) { scroll.scrollTo(Self.contentEndID, anchor: .bottom) }
        }
        .onChange(of: viewModel.outcome) { _, outcome in
            if case .given? = outcome { askHiddenAfterGiven = true }
        }
        // Another tab or "Historia" and back: the screen starts as usual.
        .onDisappear {
            askHiddenAfterGiven = false
            Task { await mealAttach.finishNow() }
        }
        #if canImport(UIKit)
        // The phone locks during "Cofnij": the join asked for does not wait for the return.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            Task { await mealAttach.finishNow() }
        }
        #endif
        // The given card's meal may have been described or merged meanwhile (here, in the Meals tab, on the other phone).
        .onAppear { refreshGivenMeal() }
        // Owner 2026-11-14: opening the tab puts the cursor in the carbs with the keyboard up — not while a command is on
        // its way, Trio's answer is on screen, the tour runs or a sheet is open.
        .task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled, !tourStillToCome, focused == nil, tour == nil, !viewModel.isLocked, viewModel.outcome == nil,
                  viewModel.retry == nil, !showsReminders, !showsHistory, !showsChecks, describeMealRoute == nil,
                  pendingDangerConfirmation == nil, !viewModel.pendingLowGlucoseConfirmation else { return }
            focused = .carbs
        }
        .task {
            // The first frames' heights are not the screen's (data and fonts still coming): fit after they settle.
            try? await Task.sleep(for: .milliseconds(600))
            layoutSettled = true
            measureRestChartBonus()
            fitRestChart()
        }
        // The plan on the chart: read every minute while "Prognoza glukozy" is on and the screen is open.
        .task(id: predictionOn && scenePhase == .active) {
            guard predictionOn else {
                predictionPlan.clear()
                return
            }
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await predictionPlan.load()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .task(id: liveUpdates.map(ObjectIdentifier.init)) {
            guard let liveUpdates else { return }
            for await _ in liveUpdates.changes.filter({ $0.concerns(kind: "meal") || $0.concerns(kind: "meals") }).values {
                refreshGivenMeal()
            }
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
                if !viewModel.flow.bolusAcknowledged, !viewModel.isLocked {
                    // Once per phone: the slider stays off until the DIY acknowledgement is accepted.
                    DIYBolusAcknowledgementRow(acknowledged: false) { viewModel.flow.acceptBolusAcknowledgement() }
                        .transition(.opacity)
                }
                if let notice = viewModel.slideNotice {
                    Label(notice, systemImage: "arrow.clockwise").font(.footnote).foregroundStyle(.orange)
                }
                if let retryAt = viewModel.flow.retryAt, !viewModel.isLocked {
                    AppleRetryFailureLine(text: viewModel.flow.retryFailure)
                        .transition(.opacity)
                } else if case let .failed(message) = viewModel.flow.state, viewModel.outcome == nil {
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
                        if let retryAt = viewModel.flow.retryAt {
                            AppleRetryWaitBar(retryAt: retryAt)
                        } else {
                            SlideToConfirm(title: slideTitle, subtitle: slideSubtitle, isEnabled: BolusTour.slideEnabled(viewModel.canGive && !sliderBusy && !typingOwnDose && viewModel.waitingUntil == nil, tour: tour), looksEnabled: (viewModel.canGive || sliderBusy) && !typingOwnDose && viewModel.waitingUntil == nil, busy: sliderBusy, tint: sliderWarns ? .orange : nil) {
                                slide()
                            } onHolding: { holding in
                                sliderTouched = holding
                                viewModel.sliderHoldsDose = holding || pendingDangerConfirmation != nil
                            }
                            // A new slider after each attempt (sent, refused, data read again): the knob starts at the left again.
                            .id(slideResetKey)
                        }
                    }
                    .lowGlucoseInsulinConfirmation(isPresented: $viewModel.pendingLowGlucoseConfirmation, insulin: viewModel.insulinU, warnings: viewModel.preview?.warnings ?? []) {
                        viewModel.give(lowGlucoseConfirmed: true)
                    }
                    .dangerWarningsConfirmation(pending: $pendingDangerConfirmation, insulin: viewModel.insulinU, lower: lowerDoseOffer, onLower: { _ in
                        viewModel.selectDoseSegment(.calculator)
                    }) {
                        viewModel.give()
                    }
                    .onChange(of: pendingDangerConfirmation == nil) { _, closed in
                        viewModel.sliderHoldsDose = sliderTouched || !closed
                    }
                    .transition(.opacity)
                }
                // v4: the meal's options under the slider, one quiet row; with the keyboard up it is the keyboard's bar
                // with "Gotowe" (the same place, nothing moves).
                optionsRow
            }
            .animation(.easeInOut(duration: 0.25), value: viewModel.isLocked)
            .animation(.easeInOut(duration: 0.25), value: viewModel.flow.retryAt)
            .animation(Self.layoutCurve, value: compact)
            // The slider's step points at the whole bar: "Zapisz jako posiłek" above it is in its text.
            .tourAnchor(.slider)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(.bar)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { top in
                barTop = top
                fitCompactChart()
                fitRestChart()
            }
        }
        }
    }

    private static let contentEndID = "contentEnd"

    /// v4: the chart's one height, with or without the keyboard (owner 2026-11-14: "zawsze podobne zachowanie").
    static let chartHeight: CGFloat = 144

    /// The keyboard layout's curve: no bounce (snappy overshot, the fields grew past their height and came back).
    static let layoutCurve = Animation.easeOut(duration: 0.28)


    /// While typing, the chart takes the height that makes the screen end just above the slider, and what it cannot take
    /// (it never grows past its usual height) goes to the fields.
    /// The heights measured while a change animates are the animation's, not the new layout's: fitted on them, the chart
    /// and the fields chased each other for ever (a layout loop at full CPU). So nothing is fitted until the change has
    /// settled; then once more on the settled heights.
    private func fitCompactChart() {
        let viewportHeight = barTop - scrollTop
        // Behind the reminders sheet the keyboard is down for a moment: the chart keeps its height.
        guard compact, keyboardSettled, !showsReminders, !fitAnimating, viewportHeight > 0, contentHeight > 0 else { return }
        let available = (compactChartHeight + fieldsExtraHeight + viewportHeight - contentHeight).rounded(.down)
        let fitted = min(Self.compactChartRange.upperBound, max(Self.compactChartRange.lowerBound, available))
        // The fields never grow (owner 2026-11-14: they stretched too far, then came back): the room is the chart's.
        let extra: CGFloat = 0
        guard abs(fitted - compactChartHeight) >= 1 || abs(extra - fieldsExtraHeight) >= 1 else { return }
        fitAnimating = true
        withAnimation(Self.layoutCurve) {
            compactChartHeight = fitted
            fieldsExtraHeight = extra
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            fitAnimating = false
            fitCompactChart()
        }
    }

    /// Without the keyboard: the chart gives the given card the room it needs above the slider (its question and
    /// buttons), within 110–190 pt, and takes it back when the card is smaller. Fitted on settled heights only, as above.
    private func fitRestChart() {
        // The chart keeps its height whatever the card under the fields shows (bolus screen review 2026-11-14: it shrank
        // for the given card and grew back a moment later); a card that does not fit is scrolled into view instead.
        guard !compact, restChartHeight != Self.restChartRange.upperBound else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { restChartHeight = Self.restChartRange.upperBound }
    }

    /// Once, on the settled first layout: room left above the slider on a tall phone goes to the chart, minus what the
    /// lines under the fields and one warnings row will need. Never measured again (warnings or cards do not move it).
    private func measureRestChartBonus() {
        guard !restChartBonusMeasured, !compact, barTop > scrollTop, contentHeight > 0 else { return }
        restChartBonusMeasured = true
        let free = (barTop - scrollTop) - contentHeight
        // Room kept for what may still come under the fields: the dose segment with its reason (~70 pt) and one warnings
        // row (~44 pt) with their spacing; with nothing typed also the carbs' chip.
        let reserve: CGFloat = (viewModel.carbsG ?? 0) > 0 ? 130 : 170
        let bonus = min(60, max(0, free - reserve)).rounded(.down)
        guard bonus >= 8 else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { restChartBonus = bonus }
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
        // v4: the options are a row under the slider; the tile only says how to change the grams.
        // "Teraz | Za 15 min" in the carbs tile, the same shape and place as the dose swap in the insulin tile (owner
        // 2026-11-14).
        if !viewModel.isLocked, viewModel.retry?.carbsKept != true {
            let withCarbs = (viewModel.carbsG ?? 0) > 0
            HStack(spacing: 2) {
                mealTimeOption("Teraz", selected: !viewModel.mealLater) { viewModel.mealLater = false }
                mealTimeOption("Za \(RemoteBolusViewModel.mealLaterMinutes) min", selected: viewModel.mealLater) { viewModel.mealLater = true }
            }
            .padding(3)
            .frame(maxWidth: .infinity, minHeight: 34, maxHeight: 34)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Brand.interactive.opacity(0.1)))
            .disabled(!withCarbs)
            .opacity(withCarbs ? 1 : 0.45)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Kiedy posiłek")
        }
    }

    /// The reminder badge in the carbs field's header: reminders hang on the meal the carb entry starts (without carbs there is
    /// none, nor while the command is on its way).
    private var showsReminderBell: Bool {
        !viewModel.isLocked && viewModel.retry == nil && (viewModel.carbsG ?? 0) > 0
    }

    /// The bar is there whenever something is typed (and in the tour's step).
    private var showsDoseBar: Bool {
        (viewModel.carbsG ?? 0) > 0 || viewModel.doseSwitch != nil || viewModel.insulinEdited || tourStage.showsSampleDoseSource
    }

    /// One height with or without the keyboard (its halves moved apart while it changed).
    private var doseBarHeight: CGFloat { 46 }

    /// The dose bar under the tiles: the two doses (calculator | carbs / ICR), one dose when they are the same, the dose
    /// on its way, or the way back to it after a typed dose. Swapped without a fade, never changing height.
    @ViewBuilder
    private var doseBar: some View {
        let calculating = viewModel.isCalculating
        Group {
            if let state = viewModel.doseSwitch, let values = viewModel.doseSwitchValues {
                DoseBar(state: state, calculatorU: values.calculator, icrU: values.icr,
                        calculatorWhy: doseBarCalculatorWhy(state), icrWhy: state.addsCorrection ? "bez korekty" : "z węgli",
                        height: doseBarHeight) { segment in
                    withAnimation(.snappy(duration: 0.25)) { viewModel.selectDoseSegment(segment) }
                }
                .opacity(calculating ? 0.6 : 1)
            } else if tourStage.showsSampleDoseSource {
                DoseBar(state: .init(selected: .calculator, addsCorrection: false), calculatorU: 2.15, icrU: 3.75,
                        calculatorWhy: "↓ aktywna insulina", icrWhy: "z węgli", height: doseBarHeight, isSample: true) { _ in }
            } else if viewModel.waitsForDose {
                DoseBarSingle(title: "Liczę dawkę…", subtitle: "z węgli i aktywnej insuliny", height: doseBarHeight)
                    .modifier(SkeletonPulse())
            } else if viewModel.insulinEdited, viewModel.doseSourceOffer == nil, let restore = viewModel.defaultDose, viewModel.retry == nil {
                let calculated = viewModel.preview?.dose_calculation != nil
                Button { viewModel.useICRDose() } label: {
                    DoseBarSingle(title: calculated ? "↺ Przywróć \(RemoteCommandFormat.units(restore)) j" : "↺ Z ICR: \(RemoteCommandFormat.units(restore)) j",
                                  subtitle: "Twoja dawka w polu", height: doseBarHeight)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Przywróć dawkę: \(RemoteCommandFormat.units(restore)) j")
            } else if (viewModel.carbsG ?? 0) > 0, !viewModel.insulinEdited, let dose = viewModel.insulinU, dose > 0 {
                let units = RemoteCommandFormat.units(NSDecimalNumber(decimal: dose).doubleValue)
                DoseBarSingle(title: calculating ? "\(units) j · z ICR" : "\(units) j · kalkulator = ICR",
                              subtitle: calculating ? "z węgli · kalkulator liczy…" : "z węgli, nic nie odejmuje", height: doseBarHeight)
            } else if let line = viewModel.calculatorLine ?? (calculating ? lastCalculatorLine : nil) {
                DoseBarSingle(title: line, subtitle: nil, height: doseBarHeight)
                    .opacity(calculating ? 0.6 : 1)
            } else {
                Color.clear.frame(height: doseBarHeight)
            }
        }
        // Moved as one piece (its two halves drifted apart while the keyboard came up).
        .geometryGroup()
        .tourAnchor(.doseSource)
        // The content swaps without a fade; the bar's position moves with the layout (keyboard) like everything else.
        .animation(nil, value: doseBarContentKey)
    }

    /// What the bar shows, for swapping it without a fade (its position still animates with the screen).
    private var doseBarContentKey: String {
        "\(String(describing: viewModel.doseSwitch?.selected))|\(viewModel.doseSwitchValues.map { "\($0.calculator)/\($0.icr)" } ?? "-")|\(viewModel.waitsForDose)|\(viewModel.insulinEdited)|\(viewModel.isCalculating)"
    }

    /// The calculator's dose when it is lower than the one on the form (offered in the warning's confirmation).
    private var lowerDoseOffer: Double? {
        guard let state = viewModel.doseSwitch, !state.addsCorrection, state.selected != .calculator,
              let values = viewModel.doseSwitchValues, let insulin = viewModel.insulinU,
              values.calculator < NSDecimalNumber(decimal: insulin).doubleValue - 1e-6 else { return nil }
        return values.calculator
    }

    /// v4: "Teraz | Za 15 min", the reminders and "Zapisz" in one row under the slider; "Gotowe" at its end while typing.
    private var optionsRow: some View {
        let withCarbs = (viewModel.carbsG ?? 0) > 0 && !viewModel.isLocked && viewModel.retry?.carbsKept != true
        return HStack(spacing: 8) {
            // Only the carbs' options wait for carbs; the keyboard button always works (owner 2026-11-14).
            HStack(spacing: 8) {
            reminderBell
                .layoutPriority(1)
            Button {
                guard !viewModel.saveAsMealLocked else { return }
                withAnimation(.snappy(duration: 0.2)) { viewModel.saveAsMeal.toggle() }
            } label: {
                // The row never grows past the screen (owner 2026-11-14: a set reminder's longer text pushed the whole
                // screen wider): the labels shrink, then the meal's says only "Zapisz".
                ViewThatFits(in: .horizontal) {
                    Label("Zapisz jako posiłek", systemImage: viewModel.saveAsMeal ? "checkmark" : "plus").fixedSize()
                    Label("Zapisz", systemImage: viewModel.saveAsMeal ? "checkmark" : "plus").fixedSize()
                }
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .foregroundStyle(viewModel.saveAsMeal ? Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0) : Color.secondary)
                    .background(Capsule().fill(viewModel.saveAsMeal ? Brand.interactive.opacity(0.16) : Color.primary.opacity(0.08)))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.selection, trigger: viewModel.saveAsMeal)
            .accessibilityLabel("Zapisz jako posiłek")
            .accessibilityValue(viewModel.saveAsMeal ? "zaznaczone" : "niezaznaczone")
            }
            .disabled(!withCarbs)
            // The tour points at both chips: in full colour while it does, even before carbs.
            .opacity(withCarbs || tour?.isActive == true ? 1 : 0.4)
            .tourAnchor(.reminders)
            Spacer(minLength: 0)
            if compact {
                // An icon, not "Gotowe": next to "Zapisz jako posiłek" the word was cut to "G…".
                Button { focused = nil } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 40, height: 30)
                        .background(Capsule().fill(Color.primary.opacity(0.1)))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Gotowe")
                .accessibilityHint("Chowa klawiaturę")
                .fixedSize()
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 34, maxHeight: 34)
    }

    private func mealTimeOption(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(selected ? .semibold : .regular))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(selected ? Color.white : Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0))
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(selected ? Brand.interactive : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// v4: where the dose in the field comes from, in the insulin tile's label.
    private var insulinSource: String? {
        guard (viewModel.carbsG ?? 0) > 0 || viewModel.insulinEdited else { return nil }
        if let state = viewModel.doseSwitch {
            switch state.selected {
            case .calculator?: return state.addsCorrection ? "z korektą" : "kalkulator"
            case .icr?: return "z ICR"
            case nil: return "wpisana"
            }
            if let part = viewModel.preview?.open_part, (viewModel.carbsG ?? 0) > 0 || (viewModel.insulinU ?? 0) > 0 {
                Label(part.line, systemImage: "clock.badge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
        }
        if viewModel.insulinEdited { return "wpisana" }
        return (viewModel.insulinU ?? 0) > 0 ? "z ICR" : nil
    }

    /// v4: the other dose under the big number, one tap swaps them (no sheet, no bar). While the calculator works:
    /// "kalkulator liczy…" in its place; the same dose: says so; a typed dose: the way back.
    @ViewBuilder
    private var doseSwap: some View {
        let calculating = viewModel.isCalculating
        Group {
            if let state = viewModel.doseSwitch, let values = viewModel.doseSwitchValues {
                // The other one: the dose not on the form (a typed dose: the calculator's, then carbs / ICR's).
                let other: RemoteBolusViewModel.DoseSwitchSegment = state.selected == .calculator ? .icr : .calculator
                let units = other == .calculator ? values.calculator : values.icr
                let name = state.addsCorrection ? (other == .calculator ? "z korektą" : "bez korekty") : (other == .calculator ? "kalkulator" : "z ICR")
                let why = state.addsCorrection ? (other == .calculator ? "połowa korekty, najwyżej 1 j" : "tylko z węgli") : (other == .calculator ? calculatorWhyPhrase : "tylko z węgli")
                Button {
                    withAnimation(.snappy(duration: 0.25)) { viewModel.selectDoseSegment(other) }
                } label: {
                    doseSwapLabel(icon: "arrow.left.arrow.right", title: "\(RemoteCommandFormat.units(units))\u{00A0}j · \(name)", subtitle: why)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Zamień na \(name): \(RemoteCommandFormat.units(units)) j")
                .opacity(calculating ? 0.6 : 1)
            } else if tourStage.showsSampleDoseSource {
                doseSwapLabel(icon: "arrow.left.arrow.right", title: "0,1\u{00A0}j · kalkulator", subtitle: "odejmuje aktywną insulinę")
            } else if viewModel.waitsForDose {
                doseSwapLabel(icon: nil, title: "Liczę dawkę…", subtitle: "z węgli i aktywnej insuliny")
                    .modifier(SkeletonPulse())
            } else if viewModel.insulinEdited, viewModel.doseSourceOffer == nil, let restore = viewModel.defaultDose, viewModel.retry == nil {
                Button { viewModel.useICRDose() } label: {
                    doseSwapLabel(icon: "arrow.uturn.backward", title: "Przywróć \(RemoteCommandFormat.units(restore))\u{00A0}j", subtitle: "zamiast wpisanej")
                }
                .buttonStyle(.plain)
            } else if (viewModel.carbsG ?? 0) > 0, !viewModel.insulinEdited, (viewModel.insulinU ?? 0) > 0 {
                if calculating {
                    doseSwapLabel(icon: "hourglass", title: "kalkulator liczy…", subtitle: "dawka za chwilę")
                } else {
                    doseSwapLabel(icon: "equal", title: "kalkulator = ICR", subtitle: "nic nie odejmuje")
                }
            } else {
                Color.clear.frame(height: 34)
            }
        }
        .tourAnchor(.doseSource)
        .transaction { $0.animation = nil }
        .padding(.top, 6)
    }

    private func doseSwapLabel(icon: String?, title: String, subtitle: String) -> some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon).font(.caption.weight(.semibold))
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(.caption.weight(.semibold).monospacedDigit())
                Text(subtitle).font(.caption2).foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0))
        .padding(.horizontal, 8)
        .frame(height: 34)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Brand.interactive.opacity(0.1)))
        .contentShape(Rectangle())
    }

    /// Why the calculator gives less, as a phrase under its dose ("odejmuje aktywną insulinę", "bo glukoza spada").
    private var calculatorWhyPhrase: String {
        switch viewModel.preview?.dose_calculation?.reason_code {
        case "ACTIVE_INSULIN"?, nil: return "odejmuje aktywną insulinę"
        case let code?: return RemoteBolusViewModel.loweredReasonWords(code).map { "bo \($0)" } ?? "odejmuje aktywną insulinę"
        }
    }

    /// The calculator's reason in a few words, for its half of the bar.
    private func doseBarCalculatorWhy(_ state: RemoteBolusViewModel.DoseSwitchState) -> String {
        if state.addsCorrection { return "połowa korekty" }
        let code = viewModel.preview?.dose_calculation?.reason_code
        return "↓ " + (code.flatMap(RemoteBolusViewModel.loweredReasonWords) ?? "aktywna insulina")
    }

    /// What the check of the amounts on screen says: the forecast going low, this phone's limits, the server's blocks
    /// and warnings, as ONE compact row in the colour of the most serious one (1.0.5): a tap shows them all.
    /// The warnings shown: the current check's, or the last one's while the same carbs are recalculated (it never
    /// blinks off and on, and a row of cleared carbs never comes back).
    private var displayedChecks: BolusCheckSummary {
        let current = checkSummary
        let sameCarbs = lastChecksCarbs != nil && lastChecksCarbs == viewModel.carbsG
        return current.isEmpty && viewModel.isCalculating && sameCarbs ? (lastChecks ?? current) : current
    }

    /// v4: the chart card's one status line: the most serious warning in its colour with "i N inne ›" (a tap shows them
    /// all), else nothing (owner 2026-11-14: no "all is well" line; its place stays, so nothing moves when a warning
    /// comes). Always one line high.
    @ViewBuilder
    private var chartStatusLine: some View {
        let summary = displayedChecks
        let current = checkSummary
        Group {
            if awaitingLoopAfterBolus {
                HStack(spacing: 5) {
                    ProgressView().controlSize(.mini)
                    Text("\(loop.capitalized) przelicza po bolusie · linia ciągła sprzed bolusa")
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            } else if let headline = summary.headline {
                Button { showsChecks = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: BolusChecksRow.icon(headline))
                        Text(headline.headline).lineLimit(1).minimumScaleFactor(0.8)
                        Spacer(minLength: 4)
                        if summary.items.count > 1 {
                            Text("i \(summary.items.count - 1) \(summary.items.count - 1 == 1 ? "inne" : "inne") ›")
                                .foregroundStyle(.secondary)
                                .fixedSize()
                        } else if headline.detail != nil {
                            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(BolusChecksRow.color(headline))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opacity(current.isEmpty ? 0.6 : 1)
                .accessibilityLabel(summary.collapsedAccessibilityText ?? summary.accessibilityText)
                .accessibilityHint("Stuknij, żeby zobaczyć wszystkie ostrzeżenia")
                .accessibilityIdentifier("bolus.checks")
            } else if tourStage.showsSampleChecks, let sample = BolusTour.sampleChecks.headline {
                Label(sample.headline, systemImage: "exclamationmark.octagon.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.red)
            } else if let forecast = viewModel.preview?.forecast, forecast.baseline_source != "LOOP" {
                Text("Brak prognozy \(loop.genitive): linia z trendu CGM.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tourAnchor(.checks)
        .id(BolusTourStep.checks.rawValue)
        .onChange(of: current.items.map(\.id), initial: true) { _, ids in
            if !ids.isEmpty {
                lastChecks = current
                lastChecksCarbs = viewModel.carbsG
            } else if !viewModel.isCalculating {
                lastChecks = nil
                lastChecksCarbs = nil
            }
        }
    }

    /// A bolus was given here and the loop's forecast on screen is from before it (or the given card is under 15 min old
    /// with no newer forecast): the low row and the marker wait (review 2026-11-14: "27 · 16:47" after giving 2,5 j).
    private var awaitingLoopAfterBolusSince: Date? {
        guard awaitingLoopAfterBolus, case let .given(command)? = viewModel.outcome else { return nil }
        return command.answered_at.flatMap(ServerDate.parse) ?? ServerDate.parse(command.authorized_at)
    }

    private var awaitingLoopAfterBolus: Bool {
        guard case let .given(command)? = viewModel.outcome, command.insulin_u > 0,
              (viewModel.carbsG ?? 0) == 0, (viewModel.insulinU ?? 0) == 0,
              let givenAt = command.answered_at.flatMap(ServerDate.parse) ?? ServerDate.parse(command.authorized_at),
              Date().timeIntervalSince(givenAt) < 15 * 60 else { return false }
        guard let start = viewModel.preview?.forecast.flatMap({ ServerDate.parse($0.start) }) else { return true }
        return start < givenAt
    }

    /// The checks of the amounts on screen (BolusCheckSummary): the chart's forecast, limits, blocks and warnings.
    private var checkSummary: BolusCheckSummary {
        let forecast = viewModel.previewMatchesScreen ? viewModel.preview?.forecast : nil
        return BolusCheckSummary.make(
            forecastLowAt: awaitingLoopAfterBolus ? nil : forecast?.lowDate,
            forecastLoopGenitive: forecast?.isLoopOnly == true ? loopSystem.names.genitive : nil,
            forecastLowFromDose: forecast.map { $0.low_from_dose && $0.insulin_u > 0 } ?? false,
            totalLowWithoutLine: forecast?.totalLowWithoutLine,
            totalFromDashedLine: forecast?.hasExcessModel == true,
            doseLineLow: forecast?.excessLine != nil || forecast?.drawsDoseLineOverLoop == true ? forecast?.lowMarker : nil,
            insulinOnForm: (viewModel.insulinU ?? 0) > 0,
            formLineStaysUp: forecast.map { ($0.excessLine != nil) && $0.lowMarker == nil } ?? false,
            carbsOnForm: (viewModel.carbsG ?? 0) > 0,
            limitProblem: viewModel.limitProblem,
            blocks: viewModel.visibleBlocks,
            warnings: viewModel.visibleWarnings,
            hidesLineNumber: predictionOn
        )
    }

    /// The slide: a DANGER warning on screen (only a short row now) is confirmed first, with its full text.
    private func slide() {
        guard tour == nil else { return }
        focused = nil
        sentForecast = viewModel.previewMatchesScreen ? viewModel.preview?.forecast : nil
        let dangers = checkSummary.confirmations
        if dangers.isEmpty {
            viewModel.give()
        } else {
            viewModel.sliderHoldsDose = true
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
                    resolvedAt: viewModel.settling.map { ["SEND_FAILED", "EXPIRED"].contains($0.status) ? 0 : 2 } ?? 2,
                    checkingSince: command.flatMap { $0.isUncertain ? ServerDate.parse($0.answered_at ?? "") ?? Date() : nil }
                )
            }
        case let .given(command)?:
            BolusOutcomeCard(
                tone: .given,
                title: givenTitle(command),
                // Settled from Nightscout without the loop's answer: said so (owner 2026-11-02).
                subtitle: command.givenAfterUncertainAnswer
                    ? "Pompa odpowiedziała niewyraźnie, ale bolus jest w historii \(loop.genitive)."
                    : RemoteCommandSettlement.seenInNightscout(command)
                    ? "Widoczne w Nightscout · \(loop.capitalized) nie \(loop.agree(m: "potwierdził", f: "potwierdziła", n: "potwierdziło")) odpowiedzią"
                    : "",
                details: nil,
                trailing: command.answered_at.flatMap(ServerDate.parse).map(RemoteCommandFormat.time),
                action: plannedMealAction ?? describeMealAction,
                secondaryAction: plannedMealAction != nil ? describeMealAction.map { BolusOutcomeAction(title: $0.title, systemImage: $0.systemImage, waitingTitle: $0.waitingTitle, perform: $0.perform, asLink: true) } : attachMealAction,
                note: mealAttach.plannedError ?? attachNote(command),
                noteIsError: { if case .failed = mealAttach.state { return true } else { return false } }(),
                link: givenMealLink,
                undo: mealAttach.canUndo ? { mealAttach.undo() } : nil,
                question: attachQuestion
            )
            .task(id: viewModel.describableMealID) {
                mealAttach.follow(commandID: command.id)
                confirmsAttach = false
                guard let api = mealAttachAPI, let mealID = viewModel.describableMealID else { return }
                await mealAttach.load(api: api, patientID: viewModel.flow.patientID, mealID: mealID)
            }
        case let .refused(command, reply)?:
            BolusOutcomeCard(
                tone: .refused,
                title: command.insulin_u > 0 ? "Bolus nie został podany" : "Węglowodany nie zostały zapisane",
                subtitle: reply.short,
                details: reply.details,
                // What happened to the carbs and what to check, then the way on (review 2026-11-14).
                footnote: refusedFootnote(command, reply: reply)
            )
        case let .carbsOnly(command, reply)?:
            BolusOutcomeCard(
                tone: .partial,
                title: "Węglowodany zapisane, bolus nie",
                subtitle: reply.short,
                details: reply.details,
                footnote: "\(command.carbs_g) g jest już w \(loop.locative). Na suwaku zostaje sama insulina."
            )
        case let .uncertain(command)?:
            BolusOutcomeCard(
                tone: .unknown,
                title: "Nie wiadomo, czy bolus \(RemoteCommandFormat.units(command.insulin_u)) j został podany",
                subtitle: "Pompa odpowiedziała niewyraźnie, a \(loop.nominative) nie \(loop.agree(m: "zapisał", f: "zapisała", n: "zapisało")) bolusa w Nightscout. Sprawdź historię bolusów w pompie, zanim podasz kolejny.",
                details: nil,
                footnote: (command.carbs_g > 0 ? "Węglowodany \(command.carbs_g) g są zapisane w \(loop.locative). " : "") + "Jeśli bolus pojawi się później, ta karta zmieni się na „Podano”."
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

    private func refusedFootnote(_ command: RemoteCommand, reply: TrioReplyText) -> String {
        var parts: [String] = []
        if command.carbs_g > 0, command.insulin_u > 0 { parts.append("Węglowodany \(command.carbs_g) g też nie zostały zapisane w \(loop.locative).") }
        if reply.short.localizedCaseInsensitiveContains("łączności") {
            parts.append("Sprawdź, czy telefon z \(loopSystem.instrumental) jest przy pompie.")
        }
        parts.append("Wpisane wartości zostały: popraw je albo przesuń ponownie.")
        return parts.joined(separator: " ")
    }

    /// Given as a meal ("Zapisz jako posiłek"): its chat, where the AI works out the macros and WBT from a
    /// description or a photo. Waits until the server linked the dose to its meal (the loop's entry in Nightscout).
    private var describeMealAction: BolusOutcomeAction? {
        guard mealChatAPI != nil, viewModel.offersMealDescription else { return nil }
        // Asking about the carbs: the question has the buttons.
        if attachQuestion != nil { return nil }
        // Asking "Dopisać do posiłku?" in the card: its main button joins (a system dialog called its button only after
        // closing, and the card showed "Opisz posiłek" again for that moment).
        if confirmsAttach, mealAttach.offeredTarget != nil {
            return BolusOutcomeAction(title: "Dopisz do posiłku", systemImage: "link", waitingTitle: "Dopisuję…", perform: { joinMeal(carbs: nil) })
        }
        // Described already, joined to the earlier meal here, or merged away elsewhere: nothing left to describe.
        guard mealAttach.needsDescription else { return nil }
        let mealID = viewModel.describableMealID
        return BolusOutcomeAction(
            title: "Opisz posiłek",
            systemImage: "bubble.left.fill",
            waitingTitle: "Zapisuję posiłek…",
            perform: mealID.map { id in { describeMealRoute = MealRoute(patientID: viewModel.flow.patientID, mealID: id) } }
        )
    }

    /// "Do posiłku: Obiad": a dose given within 30 min of a planned meal that had none; it leads, and
    /// "Opisz posiłek" goes under it as a link (owner 2026-11-09).
    private var plannedMealAction: BolusOutcomeAction? {
        guard let api = plannedMealAPI, viewModel.offersMealDescription, mealAttach.needsDescription,
              let planned = mealAttach.plannedMeal, attachQuestion == nil else { return nil }
        return BolusOutcomeAction(
            title: "Do posiłku: \(planned.title)",
            systemImage: "fork.knife",
            waitingTitle: "Zapisuję…",
            perform: mealAttach.attachingPlanned ? nil : { Task { await mealAttach.attachToPlanned(api: api, patientID: viewModel.flow.patientID) } }
        )
    }

    /// One step: the question goes and the join starts together ("Opisz posiłek" never shows in between).
    private func joinMeal(carbs: MealMergeCarbsChoice?) {
        guard let api = mealAttachAPI else { return }
        withAnimation(BolusMealAttachModel.change) {
            mealAttach.beginAttaching(carbs: carbs)
            confirmsAttach = false
        }
        Task { await mealAttach.attach(api: api, patientID: viewModel.flow.patientID) }
    }

    /// The meal has carbs of its own and the dose adds some: only the caregiver knows whether they were counted.
    private var attachQuestion: BolusOutcomeQuestion? {
        guard confirmsAttach, let target = mealAttach.offeredTarget, let carbs = target.carbs else { return nil }
        let text = MealMergeCarbsText(carbs, loopLocative: loop.locative)
        return BolusOutcomeQuestion(
            target: "Dopisać do: \(target.joinedName)?",
            context: text.context,
            question: text.question,
            included: BolusOutcomeAnswer(title: text.includedTitle, result: text.includedResult) { joinMeal(carbs: .included) },
            extra: BolusOutcomeAnswer(title: text.extraTitle, result: text.extraResult) { joinMeal(carbs: .extra) },
            footnote: "\(loop.nominative) i podana insulina się nie zmienią.",
            decline: { withAnimation(BolusMealAttachModel.change) { confirmsAttach = false } }
        )
    }

    /// "Do posiłku: Pizza margherita" / "Do posiłku o 12:45" while there is a bigger meal to join; gone once joined.
    private var attachMealAction: BolusOutcomeAction? {
        guard mealAttachAPI != nil, viewModel.offersMealDescription, attachQuestion == nil else { return nil }
        switch mealAttach.state {
        case let .offered(target), let .failed(target, _):
            if confirmsAttach {
                return BolusOutcomeAction(title: "Nie dopisuj", systemImage: "xmark", waitingTitle: "", perform: {
                    withAnimation(BolusMealAttachModel.change) { confirmsAttach = false }
                })
            }
            return BolusOutcomeAction(title: target.buttonTitle, systemImage: "link", waitingTitle: "Dopisuję…", perform: {
                withAnimation(BolusMealAttachModel.change) { confirmsAttach = true }
            })
        case .undoable, .attaching, .none, .attached:
            return nil
        }
    }

    private func attachNote(_ command: RemoteCommand) -> String? {
        guard viewModel.offersMealDescription else { return nil }
        if mealAttach.joinedTarget != nil {
            let carbs = mealAttach.joinedCarbs.map { "Posiłek ma \(MealMergeCarbsText.grams($0)). " } ?? ""
            return "\(carbs)W zakładce Posiłki ten wpis nie jest już osobnym posiłkiem. Węglowodany można zmienić na stronie posiłku przez „Edytuj ręcznie”."
        }
        if attachQuestion != nil { return nil }
        if confirmsAttach, let target = mealAttach.offeredTarget {
            return "Dopisać ten bolus (\(attachDose(command))) do: \(target.joinedName)? W zakładce Posiłki nie będzie już osobnym posiłkiem."
        }
        if case let .failed(_, message) = mealAttach.state { return message }
        return nil
    }

    /// "Dopisane do" / "Posiłek utworzony" with the meal's name: the row that opens it.
    private var givenMealLink: BolusOutcomeLink? {
        guard let mealID = givenMealToOpen else { return nil }
        let open = { onOpenMeal(mealID) }
        if let target = mealAttach.joinedTarget {
            // The page shows the join only once the server has it.
            return BolusOutcomeLink(caption: "Dopisane do posiłku", title: target.joinedName.capitalizedFirst, perform: {
                Task {
                    await mealAttach.finishNow()
                    onOpenMeal(mealID)
                }
            })
        }
        // Described in its chat (or by hand): the meal it became.
        return BolusOutcomeLink(caption: "Posiłek utworzony", title: mealAttach.mealName ?? "Zobacz posiłek", perform: open)
    }

    /// The meal the given card's confirmation opens: the joined one, or the dose's own once described.
    private var givenMealToOpen: String? {
        guard viewModel.offersMealDescription else { return nil }
        if let target = mealAttach.joinedTarget { return target.meal_id }
        guard !confirmsAttach, mealAttach.mealDescribed, !mealAttach.mealGone else { return nil }
        return mealAttach.currentMealID
    }

    /// Reads the given card's meal again: described, merged away, or a new bigger meal to join.
    private func refreshGivenMeal() {
        guard let api = mealAttachAPI, let mealID = viewModel.describableMealID else { return }
        Task { await mealAttach.load(api: api, patientID: viewModel.flow.patientID, mealID: mealID, force: true) }
    }

    /// "1,5 j i 15 g" for the confirmation.
    private func attachDose(_ command: RemoteCommand) -> String {
        let insulin = "\(RemoteCommandFormat.units(command.insulin_u)) j"
        switch (command.insulin_u > 0, command.carbs_g > 0) {
        case (true, true): return "\(insulin) i \(command.carbs_g) g"
        case (true, false): return insulin
        default: return "\(command.carbs_g) g"
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
    /// Which card is under the fields: the steps stay one view while Trio works (their dots move), a new card is new.
    private var outcomeCardIdentity: String {
        switch viewModel.outcome {
        case nil, .waiting?: return "steps"
        default: return outcomeKey
        }
    }

    private var outcomeKey: String {
        switch viewModel.outcome {
        case nil: return viewModel.isLocked ? "sending" : "none"
        case let .waiting(command)?: return "waiting-\(command.status)"
        case let .given(command)?: return "given-\(command.id)"
        case let .refused(command, _)?: return "refused-\(command.id)"
        case let .carbsOnly(command, _)?: return "partial-\(command.id)"
        case let .noReply(command)?: return "noreply-\(command.id)"
        case let .uncertain(command)?: return "uncertain-\(command.id)"
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
        // A small line, not a chip (layout B, 2026-11-14: a big button read as a third dose); a 44 pt target around it.
        return Button { viewModel.mealLater.toggle() } label: {
            Label(title.lowercased(), systemImage: on ? "checkmark.circle.fill" : "circle")
                .labelStyle(BellChipLabelStyle(showsTitle: true))
                .font(.caption.weight(on ? .semibold : .regular).monospacedDigit())
                .lineLimit(1)
                .foregroundStyle(on ? Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0) : Color.secondary)
                .padding(.vertical, 12)
                .padding(.trailing, 12)
                .contentShape(Rectangle())
                .padding(.vertical, -12)
                .padding(.trailing, -12)
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
        // The sheet again (owner 2026-11-14: the menu looked worse); the screen keeps its typing layout behind it.
        return Button {
            focusBeforeReminders = focused
            showsReminders = true
        } label: {
            // One reminder: what and when; more: how many.
            Label(!on ? "Przypomnij" : plan.count == 1 ? "Przypomnę: \(plan.chipText(from: Date()))" : "\(plan.count) przypomnienia", systemImage: on ? "alarm.fill" : "alarm")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(on ? Color.white : BolusReminderStyle.tint)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(Capsule().fill(on ? BolusReminderStyle.tint : BolusReminderStyle.tint.opacity(0.16)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(on ? "Przypomnienia: \(plan.chipText(from: Date()))" : "Przypomnij")
        .accessibilityHint("WBT albo kolejna dawka po tym bolusie")
    }

    private var slideResetKey: String {
        // The low-glucose step closing (cancelled or confirmed) puts the knob back too.
        "\(viewModel.recentCommands.count)|\(String(describing: viewModel.flow.state))|\(viewModel.slideNotice ?? "")|\(outcomeKey)|\(viewModel.pendingLowGlucoseConfirmation)|\(pendingDangerConfirmation != nil)"
    }

    /// The slider waits for the check of what is on screen: in colour, the knob off, "Liczę dawkę…".
    private var sliderBusy: Bool {
        guard viewModel.flow.state != .checking else { return false }
        // A dose known on this phone goes at once, whatever is still being worked out (owner 2026-11-14: "muszę mieć
        // możliwość podania od razu"); the server checks the warnings again when it is sent.
        return viewModel.isCalculating && !viewModel.canGive
    }

    /// The caregiver is typing their own dose and the field is empty: the slider waits for it.
    private var typingOwnDose: Bool {
        focused == .insulin && viewModel.insulinEdited && viewModel.insulinText.isEmpty && (viewModel.carbsG ?? 0) > 0
    }

    /// A low the slider sends past (confirmed first): orange, "mimo spadku".
    private var sliderWarns: Bool {
        !sliderBusy && (viewModel.insulinU ?? 0) > 0 && !checkSummary.confirmations.isEmpty
    }

    private var slideTitle: String {
        if viewModel.flow.state == .checking { return "Sprawdzam dane…" }
        if typingOwnDose { return "Wpisz dawkę" }
        if sliderBusy {
            if calculatingLong { return "Liczę dłużej niż zwykle…" }
            // The number is in the field (typed, chosen): it is checked; none yet: it is worked out.
            return (viewModel.insulinU ?? 0) > 0 ? "Sprawdzam dawkę…" : "Liczę dawkę…"
        }
        let insulin = viewModel.insulinU ?? 0

        switch viewModel.outcome {
        case .carbsOnly? where insulin > 0:
            return "Przesuń, aby podać sam bolus \(RemoteCommandFormat.units(insulin)) j"
        case .refused? where insulin > 0:
            return "Przesuń, aby ponowić \(RemoteCommandFormat.units(insulin)) j"
        default:
            break
        }
        if insulin > 0, let carbs = viewModel.carbsG, carbs > 0, viewModel.outcome == nil {
            return "Przesuń, aby podać \(RemoteCommandFormat.units(insulin)) j i \(carbs) g"
        }
        if insulin > 0 { return "Przesuń, aby podać \(RemoteCommandFormat.units(insulin)) j" }
        if let carbs = viewModel.carbsG, carbs > 0 { return "Przesuń, aby wysłać \(carbs) g" }
        return "Wpisz węglowodany lub insulinę"
    }

    /// Who gets it, on its own line: the name never squeezes the amount out of the slider.
    private var slideSubtitle: String? {
        guard viewModel.flow.state != .checking, (viewModel.insulinU ?? 0) > 0 || (viewModel.carbsG ?? 0) > 0 else { return nil }
        // v4: the warning the slide goes past on the second line, with whom it is for.
        let name = PatientBadge.firstName(viewModel.flow.patientName).map { "dla: \($0)" }
        if sliderWarns, viewModel.outcome == nil {
            let why = checkSummary.confirmations.contains { $0.id == "forecast-low" } ? "mimo prognozy poniżej 70" : "mimo ostrzeżenia"
            return [why, name].compactMap { $0 }.joined(separator: " · ")
        }
        return name
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
            case .partial: return "Węglowodany zapisane, bolus nie"
            case .unknown: return "Brak odpowiedzi \(loop.genitive)"
            case .uncertain: return "Nie wiadomo, czy bolus podano"
            }
        }
        guard case let .waiting(command)? = viewModel.outcome else { return "Wysyłam do \(loop.genitive)…" }
        if command.isUncertain { return "Sprawdzam, czy bolus podano…" }
        if command.status == "AUTHORIZED" { return "Wysyłam do \(loop.genitive)…" }
        if command.status == "SENT" { return "Czekam na \(loop.genitive)…" }
        if command.insulin_u > 0 { return "\(loop.capitalized) podaje \(RemoteCommandFormat.units(command.insulin_u)) j…" }
        return "\(loop.capitalized) zapisuje \(command.carbs_g) g…"
    }

    /// One amount as a half-width input field: icon and name on top ("z ICR" on the insulin while it is carbs / ICR), the
    /// number large below with its unit (tap anywhere to type, "0" when empty). Locked (a padlock, dimmed) while the
    /// command is on its way; the carbs Trio already has as "✓ 30 g w Trio".
    private func amountField<Footer: View>(
        _ field: Field, label: String, note: String? = nil, icon: String, text: Binding<String>, unit: String, tint: Color, inTrio: Int?,
        @ViewBuilder footer: () -> Footer
    ) -> some View {
        let isFocused = focused == field
        let locked = viewModel.isLocked
        // Locked: both amounts in one colour (the dimmed teal insulin read darker than the dimmed white carbs).
        let valueColor: Color = !locked && field == .insulin ? .accentColor : .primary
        return VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 26, height: 26)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint.opacity(0.16)))
                // "Węglowodany" always (review 2026-11-14: "Węgle" while locked moved the layout), smaller on a narrow phone.
                // A step smaller first, then the short word.
                ViewThatFits(in: .horizontal) {
                    Text(label).font(.footnote).lineLimit(1).fixedSize()
                    Text(label).font(.caption).lineLimit(1).fixedSize()
                    Text(label).font(.caption2).lineLimit(1).fixedSize()
                    Text(label).font(.caption2).lineLimit(1).minimumScaleFactor(0.7)
                }
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(label)
                    // Room for the reminder badge laid over the header, kept also while it is hidden or empty: the label
                    // keeps one size whatever the badge shows.
                    // The insulin's calculator switch the same way.
                    .padding(.trailing, field == .insulin && !locked ? 30 : 0)
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
                    // The dose waits for the check: "–,–" pulsing, not a "0 j" that reads as no dose.
                    TextField(field == .insulin && viewModel.waitsForDose ? "–,–" : "0", text: Binding(
                        get: { text.wrappedValue },
                        set: {
                            let clean = RemoteCommandFormat.sanitizedAmount($0, decimal: field == .insulin)
                            // Carbs: at most 3 digits (owner 2026-11-14); a longer paste or typing keeps the first three.
                            // The longer text goes in first and is cut on the next turn, so the field redraws: setting the
                            // same three digits again would leave the fourth one on screen.
                            text.wrappedValue = clean
                            if field == .carbs, clean.count > 3 {
                                DispatchQueue.main.async { text.wrappedValue = String(clean.prefix(3)) }
                            }
                        }
                    ))
                    #if os(iOS)
                    .keyboardType(field == .insulin ? .decimalPad : .numberPad)
                    #endif
                    .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(valueColor)
                    .focused($focused, equals: field)
                    .disabled(locked)
                    .modifier(PulseIf(active: field == .insulin && viewModel.waitsForDose))
                    .fixedSize()
                    .layoutPriority(2)
                    let unitText = Text(unit)
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                    // v4: where the dose comes from, right after its unit ("z ICR", "kalkulator", "wpisana"). With a
                    // long dose ("15,35") the word goes small above the unit instead of being cut (owner 2026-11-14).
                    if let note, !locked {
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                unitText
                                Text(note).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                            }
                            .fixedSize()
                            VStack(alignment: .leading, spacing: 0) {
                                Text(note).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                                unitText
                            }
                            .fixedSize()
                            .alignmentGuide(.firstTextBaseline) { $0[.lastTextBaseline] }
                        }
                        .layoutPriority(1)
                    } else {
                        unitText
                            .fixedSize()
                            .layoutPriority(2)
                    }
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
            if field == .insulin, !locked, let details = viewModel.calculatorDetails {
                // "Skąd ta dawka" in the insulin tile's corner (owner 2026-11-14), not beside the dose bar.
                DoseDetailsButton(details: details)
                    .transition(.opacity)
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
        .onTapGesture { if inTrio == nil && !locked && tour?.isActive != true { focused = field } }
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
                                showsHistory = false
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
        .modifier(ListPullToRefresh(pull: pull) { await viewModel.refreshRecent() })
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
    @Environment(\.colorScheme) private var colorScheme

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
                        ForEach(summary.items.filter { $0.id != headline.id || $0.detail != nil }) { item in
                            // The row's own headline is not said again: only its explanation (review 2026-11-14).
                            if item.id == headline.id, let detail = item.detail {
                                Text(detail)
                                    .font(.footnote)
                                    .foregroundStyle(.primary.opacity(0.8))
                                    .fixedSize(horizontal: false, vertical: true)
                            } else {
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
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .transition(.opacity)
                }
            }
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Self.color(headline).opacity(colorScheme == .dark ? 0.16 : 0.1)))
            // At night the border carries the colour (a dark red fill alone was hard to see).
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Self.color(headline).opacity(colorScheme == .dark ? 0.6 : 0.25), lineWidth: 1))
        }
    }

    static func color(_ item: BolusCheckItem) -> Color {
        switch item.level {
        case .block, .danger: return Brand.dynamic(light: 0xE5281E, dark: 0xFF6B6B)
        case .warning: return Brand.dynamic(light: 0xE07800, dark: 0xFFA94D)
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
    /// Its spinner waits between the glucose and IOB after a pull, over the row: nothing moves when it shows.
    var pull: PullModel?
    /// The glucose kept on the phone until the first check answers: dimmed, with its real age.
    var provisional: RemoteCommandContextView.Glucose?

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if let glucose = context?.glucose {
                VStack(alignment: .leading, spacing: 2) {
                    valueRow(glucose)
                    age(glucose.observed_at)
                }
            } else if let provisional {
                VStack(alignment: .leading, spacing: 2) {
                    valueRow(provisional)
                    age(provisional.observed_at)
                }
                // The value kept on the phone is real, with its real age: in full colour from the first frame (it was
                // grey for 2–3 s on opening the tab).
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
        .overlay {
            if let pull { PullRefreshSpinner(pull: pull, size: .small) }
        }
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
        // While loading their place is held ("—"): the glucose row does not move when they come.
        if iob != nil || cob != nil || loading {
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
            Text(context == nil ? "—" : "Brak odczytu").font(.footnote).foregroundStyle(.secondary)
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
    /// Without the keyboard: 190, lower when the card under the fields needs the room.
    var chartHeight: CGFloat = 190
    /// The glucose, IOB and COB shown in the header while typing (the row above the chart makes way then).
    var context: RemoteCommandContextView? = nil
    /// "Prognoza glukozy": what is planned, on the chart.
    var plan: ChartPredictionLine? = nil
    /// A bolus was just given: the loop's line is from before it (its marker and the low row wait for the next one).
    var afterBolus = false
    /// The forecast with the dose that was sent: its dashed line stays while the loop works out the next one.
    var afterBolusForecast: BolusForecastChart? = nil
    var afterBolusSince: Date? = nil
    /// v4: one line under the glucose: the warning (or that the forecast stays up), always the same height.
    var status: AnyView? = nil
    /// The ⓘ next to "Prognoza": how to read the line.
    @State private var showsInfo = false
    @Environment(\.predictionLineOn) private var predictionOn

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if compact {
                // No loader here (it pushed IOB and COB aside): the chart shows it while typing.
                TimelineView(.periodic(from: .now, by: 15)) { timeline in
                    BolusGlucoseInline(context: context, now: timeline.date)
                }
                .transition(.opacity)
                if let status {
                    status.frame(height: 20, alignment: .leading)
                }
            } else {
            HStack(spacing: 8) {
                Text("Prognoza")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                if let forecast, !loading {
                    Button { showsInfo = true } label: {
                        Image(systemName: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Jak czytać prognozę")
                    .popover(isPresented: $showsInfo) {
                        // Scrolls when the whole text does not fit next to the chart.
                        ViewThatFits(in: .vertical) {
                            explanationText(forecast)
                            ScrollView { explanationText(forecast) }
                        }
                        .presentationCompactAdaptation(.popover)
                    }
                }
                Spacer(minLength: 4)
                ZStack(alignment: .trailing) {
                    if afterBolus, let forecast {
                        // The legend stays (the dashed line of the given dose needs its name); the loop's state is
                        // the line under the chart.
                        chartLegend(forecast)
                            .transition(.opacity)
                    } else if afterBolus {
                        // One text from the first frame after "Podano" (it said "Liczę prognozę" first).
                        TimelineView(.periodic(from: .now, by: 30)) { timeline in
                            let late = afterBolusSince.map { timeline.date.timeIntervalSince($0) > 6 * 60 } ?? false
                            HStack(spacing: 5) {
                                if !late { ProgressView().controlSize(.mini) }
                                Text(late ? "\(loop.capitalized) jeszcze nie \(loop.agree(m: "przysłał", f: "przysłała", n: "przysłało")) nowej prognozy" : "\(loop.capitalized) przelicza po bolusie")
                            }
                        }
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                    } else if loading || updating {
                        HStack(spacing: 5) {
                            ProgressView().controlSize(.mini)
                            Text("Liczę prognozę")
                        }
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                    } else if let forecast {
                        chartLegend(forecast)
                            .transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: loading || updating || afterBolus)
            }
            .transition(.opacity)
            }
            // One chart from the first read on: its frame and the readings at once, the forecast drawn in when it comes.
            if loading || readings.count >= 2 || forecast != nil {
                // While typing the chart is too low for the plan's labels.
                BolusForecastChartView(readings: readings, forecast: forecast, updating: updating, pending: loading, plan: compact ? nil : plan, afterBolus: afterBolus, afterBolusForecast: afterBolusForecast)
                    .frame(height: compact ? compactChartHeight : chartHeight)
                    // While typing the header holds the glucose: the legend sits on the chart.
                    .overlay(alignment: .topTrailing) {
                        // While typing the legend sits on the chart, and "Liczę prognozę" in its place (never over the line).
                        Group {
                            if compact && updating {
                                HStack(spacing: 5) {
                                    ProgressView().controlSize(.mini)
                                    Text("Liczę prognozę")
                                }
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                            } else if compact, let forecast {
                                chartLegend(forecast)
                            }
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(DashboardPalette.cardBackground.opacity(compact ? 0.85 : 0)))
                        .allowsHitTesting(false)
                        // Left of the axis labels' column (it covered "250").
                        .padding(.trailing, 30)
                    }
                    .animation(.easeInOut(duration: 0.25), value: compact && updating)
                    .transition(.opacity)
            } else {
                Text("Brak odczytów z ostatnich 2 godzin.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: compact ? compactChartHeight : 120)
            }
            if afterBolus, !compact {
                TimelineView(.periodic(from: .now, by: 30)) { timeline in
                    let late = afterBolusSince.map { timeline.date.timeIntervalSince($0) > 6 * 60 } ?? false
                    HStack(spacing: 5) {
                        if !late { ProgressView().controlSize(.mini) }
                        Text(late ? "\(loop.capitalized) jeszcze nie \(loop.agree(m: "przysłał", f: "przysłała", n: "przysłało")) nowej prognozy" : "\(loop.capitalized) przelicza po bolusie · linia ciągła sprzed bolusa")
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
            } else if !compact, !loading {
                // At most one line under the chart (1.0.5): the legend names the line ("Trio"); the longer
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
                } else {
                    // The line's place is kept empty: "Trio przelicza po bolusie" later moves nothing below the chart.
                    Text(" ").font(.caption2).accessibilityHidden(true)
                }
            } else if !compact {
                Text(" ").font(.caption2).accessibilityHidden(true)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: loading)
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(DashboardPalette.cardBackground))
    }

    /// Behind the ⓘ: what the line is (it was the caption under the chart until 1.0.5).
    private func explanationText(_ forecast: BolusForecastChart) -> some View {
        Text(forecastExplanation(forecast))
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
            .frame(idealWidth: 280)
            .padding()
    }

    private func forecastExplanation(_ forecast: BolusForecastChart) -> String {
        let line = lineExplanation(forecast)
        let text = predictionOn ? "\(line)\n\n\(PredictionExperimentText.bolusChartNote)" : line
        // The curve the dose is spread over (insulin-curve.v1), when a line with it is drawn.
        guard forecast.excessLine != nil || (!forecast.isLoopOnly && forecast.with_dose != nil), let curve = forecast.insulinCurveDescription else { return text }
        return "\(text)\n\n\(curve)."
    }

    private func lineExplanation(_ forecast: BolusForecastChart) -> String {
        if forecast.baseline_source != "LOOP" {
            return "Brak świeżej prognozy \(loop.genitive): linia bez dawki jest z trendu CGM."
        }
        if forecast.isLoopOnly, forecast.excessLineIsCarbsOnly {
            return "Linia ciągła to prognoza \(loop.genitive), bez wpisanych węglowodanów: \(loop.nominative) uwzględni je dopiero po wysłaniu. Linia przerywana „z węglami” pokazuje wzrost od tych węglowodanów bez insuliny (węglowodany × ISF / ICR, rozłożone w czasie według działania insuliny)."
        }
        if forecast.isLoopOnly, forecast.excessLine != nil {
            return "Linia ciągła to prognoza \(loop.genitive) teraz, bez wpisanego posiłku i dawki. Linia przerywana „po posiłku i dawce”: ta sama prognoza z różnicą między dawką a węglowodanami z przelicznika (dawka − węglowodany/ICR), rozłożoną w czasie według działania insuliny. Dawka z samego przelicznika nie zmienia linii."
        }
        if forecast.isLoopOnly {
            return "Linia to prognoza \(loop.genitive). Tej dawki na niej nie ma: \(loop.nominative) uwzględni ją dopiero po podaniu."
        }
        return "Linia ciągła to prognoza z tą dawką, przerywana bez niej."
    }

    /// Always one short line (1.0.9): "— Trio  - - z tą dawką"; the ⓘ says the rest.
    private func chartLegend(_ forecast: BolusForecastChart) -> some View {
        HStack(spacing: 10) {
            if forecast.isLoopOnly {
                // Only the loop's own forecast: it does not include the meal and the dose on the form (review
                // 2026-11-14: "bez tej dawki" read as if the insulin raised the glucose, the difference was the carbs).
                let given = afterBolus ? afterBolusForecast : nil
                let dashed = given != nil || forecast.excessLegend != nil || forecast.drawsDoseLineOverLoop
                legendLine(forecast.baseline_source != "LOOP" ? "trend CGM" : "\(loop.nominative) teraz", color: .accentColor, dashed: false)
                if let given {
                    legendLine("po podanej dawce", color: BolusForecastChartView.excessColor, dashed: true)
                } else if dashed {
                    // On the loop's line (carbs / ICR's dose) its dashes are cut into it, so the same words fit.
                    legendLine(forecast.excessLineIsCarbsOnly ? "po posiłku" : "po posiłku i dawce", color: BolusForecastChartView.excessColor, dashed: true)
                }
            } else {
                if forecast.with_dose != nil {
                    legendLine("z tą dawką", color: .accentColor, dashed: false)
                }
                legendLine("bez", color: .secondary, dashed: true)
            }
        }
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
                .lineLimit(1)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .fixedSize()
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
/// forecast), one red marker with its value and time at the lowest point below 70 of the line that matters (the dashed
/// one when drawn). The scale starts at 220 like the dashboard's.
struct BolusForecastChartView: View {
    let readings: [DashboardReading]
    let forecast: BolusForecastChart?
    /// The forecast is being worked out for new amounts: the old one fades (the card's header says so).
    var updating = false
    /// The chart is still being read: its frame is there with a sheen over it, then the readings and the forecast are
    /// drawn in together from the left.
    var pending = false
    /// "Prognoza glukozy": what is planned, as marks. Not on the lines.
    var plan: ChartPredictionLine? = nil
    /// A bolus was just given and the loop's forecast is from before it.
    var afterBolus = false
    /// The forecast with the dose that was sent (its dashed line stays, the old loop line is dimmed).
    var afterBolusForecast: BolusForecastChart? = nil

    /// How much of the readings and the forecast is shown, from the left (0 → 1 as they are drawn in).
    @State private var reveal: CGFloat = 1
    /// "Prognoza glukozy" is on: the red marker says no number.
    @Environment(\.predictionLineOn) private var predictionOn
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
        let banded: [BolusForecastChart.Point]
        /// The one red marker: the lowest point below 70 of the line that matters (BolusForecastChart.lowMarker).
        let lowPoint: BolusForecastChart.Point?
        let start: Date
        let end: Date
        let minValue: Double
        let maxValue: Double
        let lines: [(Double, Color)]
    }

    /// The readings kept on the phone stay visible from the first frame: only the forecast is drawn in, from "now".
    private func pastShare(_ scale: Scale) -> CGFloat {
        guard !scale.past.isEmpty, scale.end > scale.start else { return 0 }
        return CGFloat(scale.now.timeIntervalSince(scale.start) / scale.end.timeIntervalSince(scale.start))
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
        // While the forecast is worked out for new amounts the dashed line of the old dose goes at once (it never shows
        // a dose other than the field's); the loop's own line and its band stay as they are.
        // The dose ON the form always has its line (review 2026-11-14): carbs / ICR's own dose leaves the loop's line as
        // it is, so the dashed line runs over it.
        let lineOf = { (chart: BolusForecastChart) -> [BolusForecastChart.Point]? in
            chart.excessLine.map { chart.points($0) } ?? (chart.drawsDoseLineOverLoop ? chart.points(chart.baseline) : nil)
        }
        let doseLine = forecast.flatMap(lineOf) ?? []
        // After "Podano": the line of the dose that was given, until the loop's own forecast knows it.
        let excess = afterBolus ? (afterBolusForecast.flatMap(lineOf) ?? []) : updating ? [] : doseLine
        // Right after a bolus the loop's line does not know it yet: no red marker on it until the loop's next forecast.
        // While the form's new amounts are worked out the marker of the last check is not theirs: none until the answer.
        let lowPoint = afterBolus ? afterBolusForecast?.lowMarker : updating ? nil : forecast?.lowMarker
        let start = now.addingTimeInterval(-Self.pastSeconds)
        let end = max(now, baseline.last?.date ?? now).addingTimeInterval(baseline.isEmpty ? Self.aheadSeconds : 0)
        let values = past.map(\.value) + baseline.map(\.value) + withDose.map(\.value) + excess.map(\.value)
        let minValue = min(40.0, Double((values.min() ?? 40) - 10))
        let maxValue = max(Self.lowestTop, ((Double(values.max() ?? 0) + 10) / 25).rounded(.up) * 25)
        let lines: [(Double, Color)] = [(250, DashboardPalette.red.opacity(0.45)), (180, DashboardPalette.yellow.opacity(0.7)), (70, DashboardPalette.red.opacity(0.7))].filter { $0.0 < maxValue }
        return Scale(now: now, past: past, baseline: baseline, withDose: withDose, excess: excess, banded: banded, lowPoint: lowPoint, start: start, end: end, minValue: minValue, maxValue: maxValue, lines: lines)
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
                Rectangle().frame(width: max(0, plotMinX + (plotMaxX - plotMinX) * max(reveal, pastShare(scale)) + 2))
            }
            .allowsHitTesting(false)
            // No sheen any more (review 2026-11-14: a grey wash over the future while the first forecast comes): the band
            // and the readings, and "Liczę prognozę" in the header.
        }
        .onChange(of: pending) { wasPending, isPending in
            guard wasPending, !isPending else { return }
            reveal = 0
            withAnimation(.easeOut(duration: 0.6)) { reveal = 1 }
        }
        .onAppear { if pending { reveal = 0 } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(pending ? "Wykres glukozy: liczę prognozę" : updating ? "Wykres glukozy: liczę prognozę" : accessibilityText(withDose: scale.withDose, baseline: scale.baseline, excess: scale.excess, low: scale.lowPoint))
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
                    .foregroundStyle(Color.accentColor.opacity(afterBolus ? 0.06 : 0.14))
            }
            // Alone (LOOP_ONLY, bolus-forecast.v7) the loop's line is the chart's line; next to the one with the dose, dashed.
            ForEach(scale.baseline, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Bez dawki"))
                    .interpolationMethod(.monotone)
                    // After "Podano" the loop's line is from before the bolus: dimmed until its next forecast.
                    .foregroundStyle((loopOnly ? Color.accentColor : Color.secondary).opacity(afterBolus ? 0.35 : 1))
                    .lineStyle(loopOnly ? StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round) : StrokeStyle(lineWidth: 1.6, dash: [4, 3]))
            }
            ForEach(scale.withDose, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Z dawką"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.accentColor)
                    .lineStyle(StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
            }
            // "z tą dawką" (excess-insulin.v1): the loop's line minus the insulin above the carbs, dashed in a darker
            // brand tone (a light one in dark mode) over the loop's solid line.
            ForEach(scale.excess, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Z tą dawką"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Self.excessColor)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, dash: [5, 3]))
            }
            // On the loop's own line (carbs / ICR's dose): gaps cut into it, so the dashes show (review 2026-11-14).
            if overLoopLine {
                ForEach(scale.excess, id: \.date) { point in
                    LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Przerwy"))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(DashboardPalette.cardBackground)
                        .lineStyle(StrokeStyle(lineWidth: 3.2, dash: [3, 5], dashPhase: 5))
                }
            }
            // What is planned: a soft area for a possible late rise, thin lines for the rest. No values.
            ForEach(Array((plan?.zones ?? []).enumerated()), id: \.offset) { _, zone in
                RectangleMark(xStart: .value("Od", Date(timeIntervalSince1970: max(zone.from, scale.now.timeIntervalSince1970))), xEnd: .value("Do", Date(timeIntervalSince1970: min(zone.to, scale.end.timeIntervalSince1970))))
                    .foregroundStyle(Color.orange.opacity(0.09))
                    .annotation(position: .overlay, alignment: .bottomTrailing, spacing: 0, overflowResolution: .init(x: .fit(to: .plot), y: .fit(to: .plot))) {
                        Text(PredictionExperimentText.lateRise)
                            .font(.system(size: 9.5, weight: .medium))
                            .foregroundStyle(Color.orange)
                            .padding(.horizontal, 3)
                            .background(RoundedRectangle(cornerRadius: 3, style: .continuous).fill(DashboardPalette.cardBackground.opacity(0.92)))
                            .padding(.trailing, 2)
                            .padding(.bottom, 2)
                    }
            }
            // Alternating heights, so two labels close in time do not cover each other.
            ForEach(Array((plan?.markers.filter { $0.t >= scale.now.timeIntervalSince1970 && $0.t <= scale.end.timeIntervalSince1970 } ?? []).enumerated()), id: \.element.id) { index, marker in
                RuleMark(x: .value("Plan", Date(timeIntervalSince1970: marker.t)))
                    .foregroundStyle((marker.settled ? Color.secondary : (marker.isFood ? Color.orange : Color.accentColor)).opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .annotation(position: .top, alignment: .center, spacing: index.isMultiple(of: 2) ? -12 : -25, overflowResolution: .init(x: .fit(to: .plot), y: .disabled)) {
                        Text(marker.label)
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(marker.settled ? Color.secondary : (marker.isFood ? Color.orange : Color.accentColor))
                            .lineLimit(1)
                            .padding(.horizontal, 3)
                            .background(RoundedRectangle(cornerRadius: 3, style: .continuous).fill(DashboardPalette.cardBackground))
                            .overlay(RoundedRectangle(cornerRadius: 3, style: .continuous).stroke((marker.settled ? Color.secondary : (marker.isFood ? Color.orange : Color.accentColor)).opacity(0.6), lineWidth: 1))
                    }
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
            // One red marker (2026-10-30): the lowest point below 70 of the line that matters, with its value and time,
            // kept inside the plot (never over the axis labels; the legend is above the chart).
            if let lowPoint = scale.lowPoint {
                PointMark(x: .value("Czas", lowPoint.date), y: .value("mg/dL", lowPoint.value))
                    .symbolSize(50)
                    .foregroundStyle(DashboardPalette.red.opacity(afterBolus ? 0.5 : 1))
                    .annotation(position: lowPoint.date.timeIntervalSince(scale.start) > scale.end.timeIntervalSince(scale.start) * 0.82 ? .topLeading : .top, alignment: .center, spacing: 3, overflowResolution: .init(x: .fit(to: .plot), y: .fit(to: .plot))) {
                        Text(predictionOn ? PredictionExperimentText.lowMarker(lowPoint) : BolusForecastChart.lowMarkerLabel(lowPoint))
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(DashboardPalette.red.opacity(afterBolus ? 0.6 : 1))
                            .padding(.horizontal, 3)
                            .background(RoundedRectangle(cornerRadius: 3, style: .continuous).fill(DashboardPalette.cardBackground.opacity(0.85)))
                    }
            }
        }
        .modifier(BolusChartScales(start: scale.start, end: scale.end, minValue: scale.minValue, maxValue: scale.maxValue, yMarks: scale.lines.map(\.0), hourMarks: Self.hourMarks(from: scale.start, to: scale.end), labels: false))
        // The dashed line fades out at once and in when the check answers (no veil over the whole chart any more).
        .animation(.easeOut(duration: updating ? 0.15 : 0.3), value: updating)
    }

    /// The dashed line lies on the loop's own (the dose is carbs / ICR's).
    private var overLoopLine: Bool {
        let chart = afterBolus ? afterBolusForecast : forecast
        return !updating && chart?.excessLine == nil && chart?.drawsDoseLineOverLoop == true
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

    private func accessibilityText(withDose: [BolusForecastChart.Point], baseline: [BolusForecastChart.Point], excess: [BolusForecastChart.Point], low lowPoint: BolusForecastChart.Point?) -> String {
        guard let last = (withDose.isEmpty ? baseline : withDose).last else { return "Wykres glukozy z ostatnich 2 godzin" }
        // The red marker, as on screen: "najniżej 52 mg/dL o 21:15".
        let low = lowPoint.map { ", \(BolusForecastChart.lowMarkerSpoken($0))" } ?? ""
        let total: String
        if !excess.isEmpty, let line = forecast?.excessLine {
            total = forecast?.excessLineIsCarbsOnly == true
                ? ", z tymi węglowodanami za 3 godziny około \(line.last ?? last.value) mg/dL"
                : ", z tą dawką za 3 godziny około \(line.last ?? last.value) mg/dL"
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
        /// The pump's answer was garbled and the bolus did not reach Nightscout while the app checked.
        case uncertain

        init?(status: String) {
            switch status {
            case "SUCCEEDED": self = .given
            case "REJECTED", "SEND_FAILED", "EXPIRED": self = .refused
            case "PARTIAL": self = .partial
            case "NO_REPLY": self = .unknown
            case "UNCERTAIN": self = .uncertain
            default: return nil
            }
        }

        var color: Color {
            switch self {
            case .given: DashboardPalette.green
            case .refused, .partial: DashboardPalette.red
            case .unknown, .uncertain: DashboardPalette.yellow
            }
        }

        var icon: String {
            switch self {
            case .given: "checkmark"
            case .refused: "xmark"
            case .partial: "exclamationmark"
            case .unknown, .uncertain: "questionmark"
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
    /// The pump's answer was garbled (since then): the last step checks whether the bolus reached Nightscout.
    var checkingSince: Date? = nil

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
            case .uncertain?: return "Nie wiadomo"
            default: return normal
            }
        }
        if loopMeal {
            return [title(0, "Węgle\nwysłane"), title(1, "Węgle\nzapisane"), title(2, "Bolus\nwysłany"), title(3, "Bolus\npodany")]
        }
        return [
            title(0, "Wysłane"),
            "\(loop.capitalized) \(loop.agree(m: "przyjął", f: "przyjęła", n: "przyjęło"))",
            resolution == nil && checkingSince != nil ? "Sprawdzam" : title(2, givesInsulin ? "Bolus podany" : "Posiłek zapisany"),
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
        case .uncertain?: return "Bolusa nie ma w Nightscout: sprawdź historię w pompie"
        case nil: break
        }
        if let checkingSince {
            return "Pompa odpowiedziała niewyraźnie.\nSprawdzam, czy \(loop.nominative) \(loop.agree(m: "zapisał", f: "zapisała", n: "zapisało")) bolus · \(RemoteCommandFormat.clock(max(0, now.timeIntervalSince(checkingSince))))"
        }
        let doing: String
        if loopMeal {
            doing = switch step {
            case 0: "Potwierdź Face ID, wysyłam węgle"
            case 1: "Czekam, aż \(loop.nominative) zapisze węgle"
            case 2: "Węglowodany zapisane, wysyłam bolus"
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
                } else if resolution == nil, step == index, checkingSince != nil {
                    Circle().strokeBorder(DashboardPalette.yellow.opacity(0.25), lineWidth: 2.5)
                    SpinningArc(color: DashboardPalette.yellow)
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
                .foregroundStyle(resolution != nil && index == resolvedAt && resolution != .given ? resolution!.color : resolution == nil && checkingSince != nil && index == step ? DashboardPalette.yellow : reached ? Color.primary : Color.secondary)
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
/// The given card's meal row: "Posiłek utworzony" / "Dopisane do" above the meal's name, opening its page.
struct BolusOutcomeLink {
    let caption: String
    let title: String
    let perform: () -> Void
}

/// One answer of the given card's carbs question: what it says and what the meal then has.
struct BolusOutcomeAnswer {
    let title: String
    let result: String
    let perform: () -> Void
}

/// "Czy te 10 g było już wliczone w 32 g?" on the given card: two equal answers, neither suggested.
struct BolusOutcomeQuestion {
    let target: String
    let context: String
    let question: String
    let included: BolusOutcomeAnswer
    let extra: BolusOutcomeAnswer
    let footnote: String
    let decline: () -> Void
}

/// The outcome card's button; nil perform: waiting for what it needs (a spinner and the waiting title).
struct BolusOutcomeAction {
    let title: String
    let systemImage: String
    let waitingTitle: String
    let perform: (() -> Void)?
    /// A quiet text link instead of a button ("Opisz posiłek" under "Do posiłku: Obiad").
    var asLink = false
}

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
    /// A button under the title (given as a meal: "Opisz posiłek").
    var action: BolusOutcomeAction? = nil
    /// A second, quieter button under it ("Do posiłku: …").
    var secondaryAction: BolusOutcomeAction? = nil
    /// A line under the title in place of the buttons' news ("Dopisane do: …", why it failed).
    var note: String? = nil
    var noteIsError = false
    /// The meal the dose became or joined, as a row that opens its page (in place of the note).
    var link: BolusOutcomeLink? = nil
    /// The small "Cofnij" beside the note, while the join can still be taken back.
    var undo: (() -> Void)? = nil
    /// The carbs question in place of the buttons.
    var question: BolusOutcomeQuestion? = nil
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
            if let link {
                // Two lines, the full width: "Posiłek utworzony" small above the meal's name (one line wrapped after the
                // colon and left half the row empty).
                Button(action: link.perform) {
                    HStack(spacing: 10) {
                        Image(systemName: "fork.knife")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 28, height: 28)
                            .background(Circle().fill(Color.accentColor.opacity(0.15)))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(link.caption)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(link.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(DashboardPalette.chipBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Otwiera posiłek")
                .transition(Self.buttonTransition)
            }
            if let note {
                HStack(alignment: .top, spacing: 10) {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(noteIsError ? DashboardPalette.red : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let undo {
                        Button("Cofnij", action: undo)
                            .font(.footnote.weight(.semibold))
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .tint(Brand.interactive)
                            .transition(.opacity)
                    }
                }
                // Under the meal's row it starts with the row; alone, with the title.
                .padding(.leading, link == nil ? 40 : 0)
                .transition(Self.buttonTransition)
            }
            if let question {
                questionView(question)
                    .padding(.leading, 40)
                    .transition(Self.buttonTransition)
            }
            if let action {
                actionButton(action, prominent: true)
                    .padding(.top, 2)
                    .transition(Self.buttonTransition)
            }
            if let secondaryAction {
                if secondaryAction.asLink {
                    Button { secondaryAction.perform?() } label: {
                        Text(secondaryAction.title)
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 32)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Brand.interactive)
                    .disabled(secondaryAction.perform == nil)
                    .padding(.leading, 40)
                    .transition(Self.buttonTransition)
                } else {
                    actionButton(secondaryAction, prominent: false)
                        .transition(Self.buttonTransition)
                }
            }
        }
        // Whatever changes the buttons (the meal linked, described, joined): one smooth step, never a jump.
        .animation(.snappy(duration: 0.35), value: buttonsKey)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DashboardPalette.cardBackground))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(color.opacity(tone == .given ? 0.25 : 0.45), lineWidth: 1.5))
    }

    /// A button or the note comes and goes softly, the card easing to its new height.
    private static let buttonTransition: AnyTransition = .opacity.combined(with: .scale(scale: 0.97, anchor: .top))

    private var buttonsKey: String {
        [question?.question, undo == nil ? nil : "undo", action.map { "\($0.title)|\($0.perform == nil)" }, secondaryAction.map { "\($0.title)|\($0.perform == nil)" }, note, link.map { "\($0.caption)|\($0.title)" }]
            .map { $0 ?? "-" }
            .joined(separator: "||")
    }

    private func questionView(_ question: BolusOutcomeQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(question.target)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                Text(question.context)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(question.question)
                    .fontWeight(.semibold)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.subheadline)
            // Side by side; with a large text size one above the other.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    answerButton(question.included)
                    answerButton(question.extra)
                }
                VStack(spacing: 8) {
                    answerButton(question.included)
                    answerButton(question.extra)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    Text(question.footnote).lineLimit(1)
                    Spacer(minLength: 0)
                    declineButton(question)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(question.footnote).fixedSize(horizontal: false, vertical: true)
                    declineButton(question)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func answerButton(_ answer: BolusOutcomeAnswer) -> some View {
        Button(action: answer.perform) {
            VStack(spacing: 1) {
                Text(answer.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(answer.result)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.accentColor.opacity(0.16)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.accentColor.opacity(0.7), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func declineButton(_ question: BolusOutcomeQuestion) -> some View {
        Button("Nie dopisuj", action: question.decline)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Brand.interactive)
            .buttonStyle(.borderless)
    }

    @ViewBuilder
    private func actionButton(_ action: BolusOutcomeAction, prominent: Bool) -> some View {
        let label = HStack(spacing: 6) {
            if action.perform == nil {
                ProgressView().controlSize(.small).tint(prominent ? .white : .accentColor)
            } else {
                Image(systemName: action.systemImage)
            }
            Text(action.perform == nil ? action.waitingTitle : action.title)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity)
        Group {
            if prominent {
                Button { action.perform?() } label: { label }.buttonStyle(.borderedProminent)
            } else {
                Button { action.perform?() } label: { label }.buttonStyle(.bordered)
            }
        }
        .controlSize(.regular)
        .disabled(action.perform == nil)
        .padding(.leading, 40)
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
        let textColor: Color = resolution == .unknown || resolution == .uncertain ? .black : .white
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
        var parts: [String] = [command.isCheckingUncertain() ? "Sprawdzam, czy bolus został podany" : command.status_message ?? "Polecenie wysłane"]
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
        if command.status == "NO_REPLY" || command.isUncertain { return "questionmark" }
        return "clock"
    }

    static func color(_ command: RemoteCommand) -> Color {
        if command.isSuccess { return .green }
        if command.isFailure { return .red }
        if command.status == "NO_REPLY" { return .orange }
        if command.isUncertain { return .orange }
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
    /// Apple refused the last push: a waiting bar in the slider's place until then.
    var retryAt: Date? = nil
    var retryFailure = ""
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
                    // A retry after a refusal: the newest bolus the loop recorded, on top, to check nothing went before
                    // giving again (parent review 2026-11-12: a pump timeout does not always mean nothing was given).
                    if confirmation.draftBase.followsCommandID != nil {
                        VStack(alignment: .leading, spacing: 6) {
                            Label(retryLastBolusLine, systemImage: "clock.arrow.circlepath")
                                .font(.subheadline.weight(.semibold))
                                .fixedSize(horizontal: false, vertical: true)
                            // The reading stays in view on a retry, where it matters most (designer review).
                            Text(contextLine).font(.footnote)
                        }
                        .foregroundStyle(Color.primary)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.yellow.opacity(0.22), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .padding(.bottom, 10)
                    }
                    if confirmation.draftBase.followsCommandID == nil, editing == nil {
                        // The reading and its age above the amounts, never under the footer (role review 2026-11-12).
                        Text(contextLine).font(.footnote).foregroundStyle(.secondary).padding(.bottom, 6)
                    }
                    if let description = confirmation.draftBase.meal?.description {
                        Text(description).font(.subheadline).foregroundStyle(.secondary).padding(.bottom, 6)
                    }
                    amountRow(.carbs, label: confirmation.draftBase.isRescue ? "Szybkie węglowodany" : "Węglowodany", value: editing == .carbs ? display(buffer) : String(confirmation.carbsG), unit: "g", accent: confirmation.draftBase.isRescue)
                    if let maybe = confirmation.draftBase.carbsMaybeInLoopG, confirmation.carbsG == 0 {
                        // Trio enters the carbs before the bolus: after a pump that did not answer they are most likely
                        // there already, so 0 g by default (diabetologist review 2026-11-12: twice is worse than none).
                        Text("Węglowodany \(maybe)\u{00A0}g z poprzedniej próby są prawdopodobnie już w \(loop.locative). Dopisz je tylko, jeśli w \(loop.locative) nie ma tego wpisu.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 4)
                    }
                    Divider()
                    // Rescue carbs go to Trio alone, as a hypo treatment: no insulin to set.
                    if carbsOnlyCard {
                        // A card's carbs-only step: insulin comes later as its own step, so it cannot be typed here
                        // (parent review 2026-11-12: "2,7 j" from the card typed in here would be given twice).
                        HStack {
                            Text("Insulina").foregroundStyle(.secondary)
                            Spacer()
                            Text("nie teraz").font(.title3.weight(.semibold)).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 12)
                        Divider()
                    } else if !confirmation.draftBase.isRescue {
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
            .navigationTitle(confirmation.draftBase.source == .wbtScreen ? "Podaj WBT" : confirmation.draftBase.isRescue ? "Dosłodzenie do \(loop.genitive)" : confirmation.insulinU <= 0 ? "Wpisz węglowodany do \(loop.genitive)" : "Podaj bolus")
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
                    if let retryAt {
                        AppleRetryFailureLine(text: retryFailure)
                        AppleRetryWaitBar(retryAt: retryAt)
                    } else {
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
                    }
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
        // A retry opens at full height: both amounts above the footer, never hidden (role review 2026-11-12).
        .onAppear { if confirmation.draftBase.followsCommandID != nil { detent = .large } }
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
        // Parent review 2026-11-12: the same form as the card ("ICR 15 → 2,7 j"), and none for carbs alone.
        if let fromICR = confirmation.preview.icr_insulin_u, confirmation.carbsG > 0, !confirmation.draftBase.isRescue, confirmation.insulinU > 0 {
            let ratio = confirmation.preview.icr_g_per_u ?? confirmation.preview.context.icr_g_per_u
            var line = ratio.map { "ICR \(RemoteCommandFormat.units($0)) → \(RemoteCommandFormat.units(fromICR)) j" } ?? "z ICR \(RemoteCommandFormat.units(fromICR)) j"
            // What the dose adds or takes off, so the numbers add up (critic review 2026-11-12).
            let difference = NSDecimalNumber(decimal: confirmation.insulinU).doubleValue - fromICR
            if difference >= 0.05 { line += " + \(RemoteCommandFormat.units(difference)) j korekty" }
            if difference <= -0.05 {
                let falling = (confirmation.preview.context.glucose?.delta ?? 0) < 0
                line += " − \(RemoteCommandFormat.units(-difference)) j \(falling ? "na spadek" : "wg kalkulatora")"
            }
            parts.append(line)
        }
        // "2,37" typed is sent as 2,35 (rounded down to the pump step): said before sliding.
        if editing == .insulin, isChecked, parsedInsulin(buffer) != confirmation.insulinU {
            parts.append("pompa poda \(RemoteCommandFormat.units(confirmation.insulinU)) j (krok pompy)")
        }
        return parts.joined(separator: " · ")
    }

    /// "Ostatni bolus w Trio: 12:56, 3,6 j (dane z 13:35). Ponów tylko, jeśli tej dawki nie ma też na pompie."
    private var carbsOnlyCard: Bool {
        confirmation.draftBase.source == .chatCard && confirmation.draftBase.proposalID != nil && confirmation.insulinU <= 0 && confirmation.carbsG > 0
    }

    private var retryLastBolusLine: String {
        let loopAt = confirmation.preview.context.loop.flatMap { ServerDate.parse($0.observed_at) }
        // Data from before the refused attempt say nothing about it (diabetologist and parent review 2026-11-12).
        if let loopAt, let attempt = confirmation.draftBase.followsAt, loopAt < attempt {
            return "\(loop.nominative) nie \(loop.agree(m: "przysłał", f: "przysłała", n: "przysłało")) danych po próbie z \(RemoteCommandFormat.time(attempt)). Sprawdź historię bolusów na pompie."
        }
        // Data older than 5 min say nothing about the refused dose: the pump's own history then.
        if let loopAt, Date().timeIntervalSince(loopAt) > 5 * 60 {
            return "\(loop.nominative) nie \(loop.agree(m: "przysłał", f: "przysłała", n: "przysłało")) świeżych danych (ostatnie z \(RemoteCommandFormat.time(loopAt))). Sprawdź historię bolusów na pompie, zanim podasz ponownie."
        }
        guard let last = confirmation.preview.context.last_bolus, let at = ServerDate.parse(last.at) else {
            return "Sprawdź historię bolusów na pompie, zanim podasz ponownie."
        }
        let age = loopAt.map { " (dane z \(RemoteCommandFormat.time($0)))" } ?? ""
        return "Ostatni bolus w \(loop.locative): \(RemoteCommandFormat.time(at)), \(RemoteCommandFormat.units(last.units)) j\(age)."
    }

    private var contextLine: String {
        let context = confirmation.preview.context
        var parts: [String] = []
        if let glucose = context.glucose {
            // The reading's age, so it is clear it is the newest one (parent review 2026-11-12).
            let age = ServerDate.parse(glucose.observed_at).map { max(0, Int(Date().timeIntervalSince($0) / 60)) }
            let ago = age.map { $0 < 1 ? " · teraz" : " · \($0) min temu" } ?? ""
            parts.append("\(Int(glucose.value)) mg/dL\(BolusGlucoseStrip.arrowCharacter(BolusGlucoseStrip.direction(glucose)).map { " \($0)" } ?? "")\(ago)")
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
    /// Waiting for the check: in colour, the knob dimmed with a spinner (not the grey of "nothing to send").
    var busy = false
    /// Another colour for the whole slider (orange: it sends past a warning); nil: the brand colour.
    var tint: Color? = nil
    let onConfirm: () -> Void
    /// The finger is on the knob. Follows the gesture's own state, so a cancelled drag also ends it.
    var onHolding: (Bool) -> Void = { _ in }
    @State private var offset: CGFloat = 0
    @GestureState private var holding = false

    private let knob: CGFloat = 48

    var body: some View {
        let looks = looksEnabled ?? isEnabled
        let color = tint ?? Color.accentColor
        // Lighter text on the dark track (the brand teal on its own 15 % was hard to read at night).
        let textColor = tint ?? Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0)
        return GeometryReader { geometry in
            let travel = max(0, geometry.size.width - knob - 8)
            ZStack(alignment: .leading) {
                Capsule().fill(looks ? color.opacity(0.15) : Color.secondary.opacity(0.12))
                    .animation(.easeOut(duration: 0.2), value: tint == nil)
                VStack(spacing: 1) {
                    // The old text goes (120 ms) before the new one comes (180 ms): never two texts on the slider.
                    ZStack {
                        Text(title)
                            .font(.subheadline.weight(.medium))
                            .id(title)
                            .transition(.asymmetric(
                                insertion: .opacity.animation(.easeOut(duration: 0.18).delay(0.12)),
                                removal: .opacity.animation(.easeIn(duration: 0.12))
                            ))
                    }
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .opacity(0.8)
                    }
                }
                    .foregroundStyle(looks ? textColor : Color.secondary)
                    // One line each also beside the keyboard button (the slider is narrower then).
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .padding(.leading, knob)
                    .padding(.trailing, 12)
                    .opacity(travel > 0 ? 1 - Double(offset / travel) : 1)
                Circle()
                    .fill(looks ? color.opacity(busy ? 0.5 : 1) : Color.secondary.opacity(0.4))
                    .frame(width: knob, height: knob)
                    .overlay {
                        if busy {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "chevron.right.2").foregroundStyle(.white).font(.headline)
                        }
                    }
                    .animation(.easeOut(duration: 0.2).delay(0.12), value: busy)
                    .animation(.easeOut(duration: 0.2).delay(0.12), value: tint == nil)
                    .padding(4)
                    .offset(x: offset)
                    .gesture(
                        DragGesture()
                            .updating($holding) { _, state, _ in state = true }
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
        .onChange(of: holding) { _, holding in onHolding(holding) }
        // A slider replaced or removed mid-gesture never reports the end of it.
        .onDisappear { onHolding(false) }
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
    func dangerWarningsConfirmation(pending: Binding<[BolusCheckItem]?>, insulin: Decimal?, lower: Double? = nil, onLower: @escaping (Double) -> Void = { _ in }, onConfirm: @escaping () -> Void) -> some View {
        let items = pending.wrappedValue ?? []
        return alert(
            items.first?.headline ?? "Ostrzeżenie",
            isPresented: Binding(get: { pending.wrappedValue != nil }, set: { if !$0 { pending.wrappedValue = nil } })
        ) {
            Button(insulin.map { "Podaj \(RemoteCommandFormat.units($0)) j mimo to" } ?? "Podaj mimo to", role: .destructive) {
                pending.wrappedValue = nil
                onConfirm()
            }
            // v4: the calculator's lower dose one tap away (it goes on the form, nothing is sent).
            if let lower {
                Button("Zmień na \(RemoteCommandFormat.units(lower)) j") {
                    pending.wrappedValue = nil
                    onLower(lower)
                }
            }
            Button("Anuluj", role: .cancel) { pending.wrappedValue = nil }
        } message: {
            Text(items.map(\.fullText).joined(separator: "\n\n"))
        }
    }

    /// The separate step after the slide: insulin while low, or (scenario D22) after a remote bolus that may have gone,
    /// the pump's bolus history checked first.
    func lowGlucoseInsulinConfirmation(isPresented: Binding<Bool>, insulin: Decimal?, warnings: [RemoteCommandNotice] = [], onConfirm: @escaping () -> Void) -> some View {
        let unconfirmed = warnings.first { $0.code == "UNCONFIRMED_REMOTE_BOLUS" }
        let low = warnings.contains { $0.code == "INSULIN_WHILE_LOW" } || unconfirmed == nil
        return alert(low ? "Glukoza jest niska" : "Sprawdź historię bolusów w pompie", isPresented: isPresented) {
            Button("Anuluj", role: .cancel) {}
            Button(low ? "Podaj insulinę mimo niskiej glukozy" : "Sprawdziłem: tamtego bolusa nie ma, podaj", role: .destructive, action: onConfirm)
        } message: {
            if low {
                Text("Najpierw podaj węglowodany. Insulina teraz\(insulin.map { " (\(RemoteCommandFormat.units($0)) j)" } ?? "") pogłębi niedocukrzenie. Podaj ją tylko, jeśli na pewno tego chcesz.\(unconfirmed.map { "\n\n\($0.message)" } ?? "")")
            } else {
                Text("\(unconfirmed?.message ?? "") Podaj teraz tylko wtedy, gdy w historii pompy tamtego bolusa nie ma.")
            }
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

/// Apple refused the push: what happened, right above the bar that takes the slider's place.
private struct AppleRetryFailureLine: View {
    let text: String

    var body: some View {
        Label {
            Text(text).foregroundStyle(.primary)
        } icon: {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
        }
        .font(.subheadline.weight(.semibold))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Takes the slider's place, at its size, while Apple's wait lasts: there is nothing to slide, and the wait is where the
/// eyes are. The knob is the only solid colour; ends by itself (RemoteBolusFlow.retryAt).
private struct AppleRetryWaitBar: View {
    let retryAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.orange.opacity(0.18))
                VStack(spacing: 1) {
                    Text(RemoteCommandFormat.retryCountdown(until: retryAt, now: context.date))
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.primary)
                    Text(RemoteCommandFormat.retryReason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity)
                .padding(.leading, 48)
                .padding(.trailing, 12)
                Circle()
                    .fill(Color.orange)
                    .frame(width: 48, height: 48)
                    .overlay(Image(systemName: "pause.fill").foregroundStyle(.white).font(.headline))
                    .padding(4)
            }
        }
        .frame(height: 56)
        .accessibilityElement(children: .combine)
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
                        retryAt: flow.retryAt,
                        retryFailure: flow.retryFailure,
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
                    .lowGlucoseInsulinConfirmation(isPresented: $asksLowGlucose, insulin: confirmation.insulinU, warnings: confirmation.preview.warnings) {
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
/// Both doses under the insulin's number (bolus screen review 2026-11-14, instead of the corner "±/ICR"): the
/// calculator's and carbs / ICR (higher mode: the default and the default with half a correction), the one on the form
/// filled, a typed dose none. A tap puts the tapped dose on the form; the filled one stays.
struct DoseSourceSegment: View {
    let state: RemoteBolusViewModel.DoseSwitchState
    let calculatorU: Double
    let icrU: Double
    /// A picture only (the Bolus tour's sample): no taps, no actions.
    var isSample = false
    let onSelect: (RemoteBolusViewModel.DoseSwitchSegment) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // Higher mode: carbs / ICR (the default) first, then the calculator with its correction.
        let first: (RemoteBolusViewModel.DoseSwitchSegment, Double, String) = state.addsCorrection ? (.icr, icrU, "z ICR") : (.calculator, calculatorU, "kalkulator")
        let second: (RemoteBolusViewModel.DoseSwitchSegment, Double, String) = state.addsCorrection ? (.calculator, calculatorU, "z korektą") : (.icr, icrU, "z ICR")
        HStack(spacing: 4) {
            option(first.0, units: first.1, caption: first.2)
            option(second.0, units: second.1, caption: second.2)
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Brand.interactive.opacity(0.1)))
        .allowsHitTesting(!isSample)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Źródło dawki")
        .accessibilityIdentifier("bolus.doseSource")
    }

    private func option(_ segment: RemoteBolusViewModel.DoseSwitchSegment, units: Double, caption: String) -> some View {
        let selected = state.selected == segment
        return Button { onSelect(segment) } label: {
            VStack(spacing: 0) {
                Text("\(RemoteCommandFormat.units(units))\u{00A0}j")
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .contentTransition(reduceMotion ? .opacity : .numericText(value: units))
                Text(caption)
                    .font(.caption2.weight(.medium))
                    .opacity(0.85)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .foregroundStyle(selected ? Color.white : Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0))
            .frame(maxWidth: .infinity, minHeight: 34)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(selected ? Brand.interactive : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(caption): \(RemoteCommandFormat.units(units)) j")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Layout B (owner 2026-11-14): the two doses side by side under the tiles, each with its reason; the one on the form
/// filled, a typed dose none.
struct DoseBar: View {
    let state: RemoteBolusViewModel.DoseSwitchState
    let calculatorU: Double
    let icrU: Double
    let calculatorWhy: String
    let icrWhy: String
    let height: CGFloat
    var isSample = false
    let onSelect: (RemoteBolusViewModel.DoseSwitchSegment) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let first: (RemoteBolusViewModel.DoseSwitchSegment, Double, String, String) = state.addsCorrection ? (.icr, icrU, "z ICR", icrWhy) : (.calculator, calculatorU, "kalkulator", calculatorWhy)
        let second: (RemoteBolusViewModel.DoseSwitchSegment, Double, String, String) = state.addsCorrection ? (.calculator, calculatorU, "z korektą", calculatorWhy) : (.icr, icrU, "z ICR", icrWhy)
        HStack(spacing: 3) {
            option(first.0, units: first.1, name: first.2, why: first.3)
            option(second.0, units: second.1, name: second.2, why: second.3)
        }
        .padding(3)
        .frame(height: height)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(DashboardPalette.cardBackground))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
        .opacity(state.selected == nil ? 0.75 : 1)
        .allowsHitTesting(!isSample)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Źródło dawki")
        .accessibilityIdentifier("bolus.doseSource")
    }

    private func option(_ segment: RemoteBolusViewModel.DoseSwitchSegment, units: Double, name: String, why: String) -> some View {
        let selected = state.selected == segment
        return Button { onSelect(segment) } label: {
            VStack(spacing: 1) {
                (Text("\(RemoteCommandFormat.units(units))\u{00A0}j ").font(.subheadline.weight(.bold).monospacedDigit())
                    + Text(name).font(.caption.weight(.semibold)))
                    .contentTransition(reduceMotion ? .opacity : .numericText(value: units))
                Text(why)
                    .font(.caption2)
                    .foregroundStyle(selected ? Color.white.opacity(0.85) : Color.secondary)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(selected ? Color.white : Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(selected ? Brand.interactive : Brand.interactive.opacity(0.08)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name): \(RemoteCommandFormat.units(units)) j, \(why)")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The ⓘ in the insulin tile's corner: the calculator's whole explanation and formula in a popover.
struct DoseDetailsButton: View {
    let details: String
    @State private var shows = false

    var body: some View {
        Image(systemName: "info.circle")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(width: 26, height: 26)
            .padding(9)
            .contentShape(Rectangle())
            .padding(-9)
            .onTapGesture { shows = true }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Skąd ta dawka")
            .popover(isPresented: $shows) {
                Text(details).font(.footnote).fixedSize(horizontal: false, vertical: true).padding().frame(idealWidth: 280).presentationCompactAdaptation(.popover)
            }
    }
}

/// The dose bar with one thing in it (one dose, the dose on its way, "Przywróć"): the bar's height and frame.
struct DoseBarSingle: View {
    let title: String
    let subtitle: String?
    let height: CGFloat

    var body: some View {
        VStack(spacing: 1) {
            Text(title).font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(Brand.dynamic(light: 0x0F766E, dark: 0x5FD3C0))
            if let subtitle { Text(subtitle).font(.caption2).foregroundStyle(.secondary) }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Brand.interactive.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// The pulse of a placeholder, only while it waits.
struct PulseIf: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active { content.modifier(SkeletonPulse()) } else { content }
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
    var glucoseFallingNow = false
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
                        icon: "arrow.up.right", color: .accentColor, title: "Kolejna dawka, gdy glukoza zacznie rosnąć",
                        detail: glucoseRisingNow
                            ? "Glukoza już rośnie od 10 min. Możesz podać teraz."
                            : "w ciągu 1 h · gdy nie wzrośnie, przypomnienie wygaśnie",
                        isOn: plan.secondDose == .whenRising
                    ) { plan.secondDose = plan.secondDose == .whenRising ? nil : .whenRising }
                    // rest-later.v1 (owner 2026-11-10): while glucose falls, the rest when it stops.
                    if glucoseFallingNow || plan.secondDose == .whenStoppedFalling {
                        row(
                            icon: "arrow.down.right", color: .orange, title: "Kolejna dawka, gdy glukoza przestanie spadać",
                            detail: "najpóźniej za 3 h · dawkę sprawdzisz przy przypomnieniu",
                            isOn: plan.secondDose == .whenStoppedFalling
                        ) { plan.secondDose = plan.secondDose == .whenStoppedFalling ? nil : .whenStoppedFalling }
                    }
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
                    icon: "timer", color: .gray, title: "Kolejna dawka za zadany czas",
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

private extension String {
    /// "posiłek o 12:45" → "Posiłek o 12:45" (a name on its own line).
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}


extension BolusForecastChart {
    /// The dose on the form is carbs / ICR's own (no excess): its dashed line is the loop's line itself, drawn so a dose
    /// on the form always has its line (review 2026-11-14).
    var drawsDoseLineOverLoop: Bool {
        isLoopOnly && excessLine == nil && baseline_source == "LOOP" && insulin_u > 0 && carbs_g > 0 && baseline.count >= 2
    }
}
