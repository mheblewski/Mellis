import Charts
import SwiftUI

/// What the Meals tab hands back to the app: open a conversation, the Bolus tab, or a new chat.
public struct MealJournalActions {
    public var openConversation: (String) -> Void
    public var openBolusTab: () -> Void
    public var openNewChat: () -> Void

    public init(openConversation: @escaping (String) -> Void, openBolusTab: @escaping () -> Void, openNewChat: @escaping () -> Void) {
        self.openConversation = openConversation
        self.openBolusTab = openBolusTab
        self.openNewChat = openNewChat
    }
}

/// The Meals tab: the week strip (the month on demand) and the chosen day's meals from the chat and Bolus tab boluses
/// with a reminder. A meal still waiting for a reminder shows its time line unfolded; a finished one folds it (a tap
/// unfolds it). The search at the bottom finds meals of any day by their description. Nothing here waits for a
/// description.
public struct MealsJournalView<TrailingControls: View>: View {
    @StateObject private var viewModel: MealJournalViewModel
    @Environment(\.liveUpdates) private var liveUpdates
    @Environment(\.scenePhase) private var scenePhase
    @Binding private var focus: MealRoute?
    @State private var path: [String] = []
    /// A push for a meal's WBT or a planned part opens that window on the meal's page, also when the page is open.
    @State private var pageRequest: MealPageRequest?
    /// The month grid instead of the week strip.
    @State private var showsMonth = false
    /// The dashboard's pull ring instead of the system refresh control (as on the other tabs).
    @State private var pull = PullModel()
    /// Meals in view and their days: the calendar marks the top one. Not observed: a tile coming into view while
    /// scrolling must not redraw the whole tab.
    @State private var visibleMeals = VisibleMeals()
    private let api: APIClient
    private let patientName: String?
    /// The search capsule at the bottom of the tab.
    private let searchable: Bool
    private let actions: MealJournalActions
    private let trailingControls: TrailingControls

    public init(
        patientID: String,
        api: APIClient,
        focus: Binding<MealRoute?>,
        patientName: String?,
        searchable: Bool = true,
        actions: MealJournalActions,
        @ViewBuilder trailingControls: () -> TrailingControls
    ) {
        self.searchable = searchable
        _viewModel = StateObject(wrappedValue: MealJournalViewModel(patientID: patientID, api: api))
        _focus = focus
        self.api = api
        self.patientName = patientName
        self.actions = actions
        self.trailingControls = trailingControls()
    }

    public var body: some View {
        NavigationStack(path: $path) {
            ScrollViewReader { proxy in
                // A scroll view, not a List: a tile folding or unfolding changes its height with the animation (a
                // List's row jumped to its new height).
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if viewModel.isSearchActive {
                            searchSection
                        } else {
                            content
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
                .background(MealJournalStyle.page)
                // The calendar stays above the list while it scrolls, marking the day at the top.
                .safeAreaInset(edge: .top, spacing: 0) {
                    // "Brak posiłków …" just under the calendar, over the list.
                    calendarHeader.overlay(alignment: .bottom) {
                        dayNoteBubble.alignmentGuide(.bottom) { $0[.top] }
                    }
                }
                .onChange(of: viewModel.scrollRequest) { _, request in
                    guard let request else { return }
                    withAnimation(.snappy(duration: 0.35)) { proxy.scrollTo(request.day, anchor: .top) }
                }
                .onAppear { visibleMeals.onTopDayChange = { [weak viewModel] days in viewModel?.visibleDaysChanged(days) } }
            }
            .modifier(MealSearchField(isOn: searchable, query: $viewModel.query))
            // The title is drawn above the list (MealsTitle, with the refresh ring next to it); the bar keeps it for
            // the back button of the meal pages.
            .navigationTitle("Posiłki")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .navigationDestination(for: String.self) { mealID in
                MealOverviewView(
                    patientID: viewModel.patientID,
                    mealID: mealID,
                    api: api,
                    actions: actions,
                    request: pageRequest?.mealID == mealID ? pageRequest : nil
                ) { handled in
                    if pageRequest?.id == handled { pageRequest = nil }
                }
            }
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button("Dziś") {
                        Task { await viewModel.goToToday() }
                    }
                    .disabled(viewModel.isSelectedDayToday)
                }
                if let patientName {
                    ToolbarItem(placement: .principal) {
                        PatientNameBubble(name: patientName)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    trailingControls
                }
            }
            .modifier(ListPullToRefresh(pull: pull, threshold: 80) {
                await viewModel.load()
            })
            .task {
                await viewModel.load()
                #if DEBUG
                // Visual checks: GLUCOMIND_UI_FIXTURES_MEALS=<meal id> opens that meal's page.
                if let meal = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_MEALS"], meal != "1", path.isEmpty,
                   ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES"] == "1" {
                    path = [meal]
                }
                // GLUCOMIND_UI_FIXTURES_SEARCH=<text> types it into the search.
                if let text = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SEARCH"], text != "1",
                   ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES"] == "1" {
                    viewModel.query = text
                }
                #endif
            }
            .task(id: liveUpdates.map(ObjectIdentifier.init)) { viewModel.bindLiveUpdates(liveUpdates) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await viewModel.load() } }
        }
        .task(id: focus?.id) {
            guard let route = focus else { return }
            // Taken at once, also when it leads nowhere: a route left here would wait for the next visit of the tab.
            focus = nil
            guard !route.mealID.isEmpty else { return }
            pageRequest = MealPageRequest(route)
            if path != [route.mealID] { path = [route.mealID] }
        }
        .alert("Posiłki", isPresented: Binding(get: { viewModel.errorMessage != nil && viewModel.hasLoaded }, set: { if !$0 { viewModel.clearError() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    private var calendarHeader: some View {
        VStack(spacing: 6) {
            MealsTitle(
                pull: pull,
                month: MealsCalendarText.monthTitle(showsMonth ? viewModel.displayedMonth : viewModel.selectedDay),
                showsMonth: $showsMonth,
                showsMonthButton: !viewModel.isSearchActive,
                edgeInset: 0
            )
            if !viewModel.isSearchActive {
                Group {
                    if showsMonth {
                        MealsMonthCalendar(viewModel: viewModel)
                            .padding(8)
                    } else {
                        MealsWeekStrip(viewModel: viewModel)
                            .padding(.vertical, 6)
                            .padding(.horizontal, 4)
                    }
                }
                .background(MealJournalStyle.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
        .background(MealJournalStyle.page)
    }

    @ViewBuilder
    private var dayNoteBubble: some View {
        if let note = viewModel.dayNote {
            Text(note)
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .topBarBubble()
                .padding(.top, 4)
                .transition(.opacity.combined(with: .move(edge: .top)))
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private var content: some View {
        let days = viewModel.days
        if days.isEmpty {
            MealJournalCard {
                Text(emptyText)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .padding(.top, 12)
            if viewModel.loadState == .loaded {
                MealJournalSectionFooter("Tu pojawiają się posiłki opisane w czacie i bolusy z przypomnieniem z zakładki Bolus.")
            }
        }
        ForEach(days) { day in
            VStack(alignment: .leading, spacing: 0) {
                MealJournalSectionHeader(MealJournalFormat.dayTitle(day.day, calendar: viewModel.calendar))
                MealJournalCard {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(day.items.enumerated()), id: \.element.id) { index, item in
                            if index > 0 {
                                Divider().padding(.leading, 74)
                            }
                            MealJournalTile(
                                item: item,
                                busySwitches: Set(viewModel.togglingIDs),
                                onOpen: { path = [item.meal_id] },
                                onAction: { action in
                                    guard case let .setMealReminder(mealID, reminderID, enabled) = action else { return }
                                    Task { await viewModel.setReminder(mealID: mealID, reminderID: reminderID, enabled: enabled) }
                                }
                            )
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .modifier(TracksVisibility(id: item.meal_id, day: day.day, visible: visibleMeals))
                        }
                    }
                }
            }
            .id(day.day)
        }
        if viewModel.canLoadMore {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                .task { await viewModel.loadMore() }
        }
    }

    private var emptyText: String {
        switch viewModel.loadState {
        case .loading: "Wczytuję…"
        case .loaded: "Brak posiłków."
        case .failed: "Nie udało się wczytać posiłków. Pociągnij w dół, żeby spróbować ponownie."
        }
    }

    @ViewBuilder
    private var searchSection: some View {
        MealJournalCard {
            VStack(alignment: .leading, spacing: 0) {
                if viewModel.isSearching {
                    ProgressView().frame(maxWidth: .infinity).padding(16)
                } else if viewModel.searchFailed {
                    Text("Nie udało się wyszukać. Sprawdź połączenie i spróbuj ponownie.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                } else if viewModel.searchResults.isEmpty {
                    Text("Brak posiłków z takim opisem.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                } else {
                    ForEach(Array(viewModel.searchResults.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider().padding(.leading, 16) }
                        Button { path = [item.meal_id] } label: {
                            MealJournalSearchRow(item: item)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.top, 12)
        MealJournalSectionFooter("Wyszukiwanie obejmuje opisy posiłków.")
    }
}

/// A day's rounded card, as a grouped list draws its sections.
private struct MealJournalCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .background(MealJournalStyle.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

/// "Dziś", "Wczoraj", "Czwartek, 22 października" above a day's card.
private struct MealJournalSectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.top, 22)
            .padding(.bottom, 8)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct MealJournalSectionFooter: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.top, 8)
    }
}

public extension MealsJournalView where TrailingControls == EmptyView {
    init(patientID: String, api: APIClient, focus: Binding<MealRoute?>, actions: MealJournalActions) {
        self.init(patientID: patientID, api: api, focus: focus, patientName: nil, actions: actions) { EmptyView() }
    }
}

/// The search at the bottom of the Meals tab, in a glass capsule like the chat's composer (as Apple's Settings
/// does it): typing shows meals found by their description in place of the list.
private struct MealSearchField: ViewModifier {
    let isOn: Bool
    @Binding var query: String
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        if isOn {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                        TextField("Szukaj posiłku", text: $query)
                            .focused($focused)
                            .submitLabel(.search)
                            .autocorrectionDisabled()
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Wyczyść")
                        }
                    }
                    .font(.body)
                    .padding(.horizontal, 16)
                    .frame(height: 48)
                    .contentShape(Capsule())
                    .onTapGesture { focused = true }
                    .glassBubble(in: Capsule())

                    if focused || !query.isEmpty {
                        Button {
                            query = ""
                            focused = false
                        } label: {
                            Image(systemName: "xmark")
                                .font(.body.weight(.semibold))
                                .frame(width: 48, height: 48)
                        }
                        .buttonStyle(.plain)
                        .glassBubble(in: Circle())
                        .accessibilityLabel("Zamknij wyszukiwanie")
                        .transition(.opacity.combined(with: .scale(scale: 0.8)))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
                .animation(.snappy(duration: 0.25), value: focused || !query.isEmpty)
            }
        } else {
            content
        }
    }
}

enum MealJournalStyle {
    static let reminder = Color(red: 0.557, green: 0.361, blue: 0.969)
    static let bolus = Color(red: 0.039, green: 0.424, blue: 1.0)
    /// The grouped list's own background and its rows' (the calendar above the list looks like part of it).
    #if os(iOS)
    static let page = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    #else
    static let page = Color.clear
    static let card = Color.secondary.opacity(0.12)
    #endif
}

/// A meal on the list: time, name (or its carbs and insulin), the doses, and its time line in the bolus card's design,
/// unfolded while a reminder is still to come.
struct MealJournalTile: View {
    @Environment(\.loopSystem) private var loopSystem
    let item: MealJournalItem
    let busySwitches: Set<String>
    let onOpen: () -> Void
    let onAction: (CardTimelineStep.Action) -> Void
    /// nil: unfolded while a reminder is to come, folded once the meal is finished; the caregiver's tap overrides it.
    @State private var expandedChoice: Bool?
    @State private var timelineHeight: CGFloat = 0
    @State private var summaryHeight: CGFloat = 0

    private static let foldAnimation: Animation = {
        #if DEBUG
        // Visual checks: GLUCOMIND_UI_FIXTURES_SLOW_FOLD=1 folds in 3 s, so a screenshot catches it halfway.
        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SLOW_FOLD"] == "1" { return .easeInOut(duration: 3) }
        #endif
        return .snappy(duration: 0.35)
    }()

    /// Until both are measured the row takes its content's own height.
    private func frameHeight(expanded: Bool) -> CGFloat? {
        guard timelineHeight > 0, summaryHeight > 0 else { return nil }
        return expanded ? timelineHeight : summaryHeight
    }

    private func timeline(_ steps: [CardTimelineStep]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CardDoseTimeline(steps: steps, onAction: onAction, busySwitches: busySwitches)
                .padding(10)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            HStack {
                Spacer(minLength: 0)
                Button {
                    withAnimation(Self.foldAnimation) { expandedChoice = false }
                } label: {
                    Label("Zwiń", systemImage: "chevron.up").font(.footnote.weight(.semibold))
                }
                .buttonStyle(.borderless)
            }
        }
    }

    private func foldedSummary(open: Bool) -> some View {
        Button {
            withAnimation(Self.foldAnimation) { expandedChoice = true }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: open ? "clock.fill" : "checkmark.circle.fill")
                    .foregroundStyle(open ? Color.orange : Color.green)
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .tint(.primary)
        .accessibilityHint("Pokazuje oś dawek")
    }

    var body: some View {
        let open = MealJournalTimeline.isOpen(item)
        let expanded = expandedChoice ?? open
        let steps = MealJournalTimeline.steps(item: item, loopSystem: loopSystem)
        AgendaRow(time: item.startedDate.map { MealJournalFormat.clock($0) } ?? "") {
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.displayTitle)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Text(statsLine)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if steps.count > 1 || open {
                    // Both are always there: the row's height goes from one measured height to the other, so the
                    // list grows and shrinks with it (switching views made the row jump to its new height).
                    ZStack(alignment: .top) {
                        timeline(steps)
                            .fixedSize(horizontal: false, vertical: true)
                            .measuredHeight($timelineHeight)
                            .opacity(expanded ? 1 : 0)
                            .allowsHitTesting(expanded)
                            .accessibilityHidden(!expanded)
                        foldedSummary(open: open)
                            .fixedSize(horizontal: false, vertical: true)
                            .measuredHeight($summaryHeight)
                            .opacity(expanded ? 0 : 1)
                            // Gone at once when unfolding (it would lie over the time line), back at the end when folding.
                            .animation(expanded ? .easeOut(duration: 0.1) : .easeIn(duration: 0.15).delay(0.2), value: expanded)
                            .allowsHitTesting(!expanded)
                            .accessibilityHidden(expanded)
                    }
                    .frame(height: frameHeight(expanded: expanded), alignment: .top)
                    .clipped()
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .accessibilityAddTraits(.isButton)
    }

    /// "60 g węgli · 7,2 j insuliny · z czatu"
    private var statsLine: String {
        var parts: [String] = []
        if let carbs = item.carbs_g { parts.append("\(MealJournalFormat.number(carbs)) g węgli") }
        if let insulin = item.insulin_total_u, insulin > 0 { parts.append("\(MealJournalFormat.number(insulin)) j insuliny") }
        return parts.joined(separator: " · ")
    }

    /// The folded line: "Bolus 7,2 j · 2 przypomnienia".
    private var summary: String {
        var parts: [String] = []
        if let insulin = item.insulin_total_u, insulin > 0 { parts.append("Bolus \(MealJournalFormat.number(insulin)) j") }
        else if let carbs = item.carbs_g { parts.append("Wpis \(MealJournalFormat.number(carbs)) g") }
        let reminders = item.reminders.count
        if reminders > 0 { parts.append(reminders == 1 ? "1 przypomnienie" : "\(reminders) przypomnienia") }
        return parts.joined(separator: " · ")
    }
}

/// A meal row of the Meals tab: the time in a fixed left column, the content, a chevron, so the day reads top to
/// bottom like a calendar agenda.
struct AgendaRow<Content: View>: View {
    let time: String
    let content: Content

    init(time: String, @ViewBuilder content: () -> Content) {
        self.time = time
        self.content = content()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(time)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 46, alignment: .leading)
            content
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}

/// A search result: name, when, the dose and the glucose it gave.
struct MealJournalSearchRow: View {
    let item: MealJournalItem

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.displayTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let range = item.glucoseRange {
                Text(range)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        guard let start = item.startedDate else { return item.subtitle() }
        return "\(MealJournalFormat.dayTitle(Calendar.current.startOfDay(for: start))) · \(item.subtitle())"
    }
}

// MARK: - The meal's page

/// What a push asks a meal's page to open once it is read: the WBT window or a planned part's card. Every push makes a
/// new one, so a second push for the page already open is not lost.
struct MealPageRequest: Equatable {
    let id = UUID()
    let mealID: String
    let opensWbt: Bool
    let opensPlannedBolus: Bool
    let plannedBolusID: String?

    init(_ route: MealRoute) {
        mealID = route.mealID
        opensWbt = route.opensWbt
        opensPlannedBolus = route.opensPlannedBolus
        plannedBolusID = route.plannedBolusID
    }
}

public struct MealOverviewView: View {
    @Environment(\.loopSystem) private var loopSystem
    @StateObject private var viewModel: MealOverviewViewModel
    @Environment(\.liveUpdates) private var liveUpdates
    private let api: APIClient
    private let actions: MealJournalActions
    private let request: MealPageRequest?
    /// The request was carried out (or cannot be: the page did not load); the tab forgets it.
    private let onRequestHandled: (UUID) -> Void
    @State private var wbtRoute: MealRoute?
    /// The card of a planned part (the second part of a split bolus, a deferred meal bolus): it gives that part.
    @State private var plannedPartRoute: MealRoute?
    @State private var chatRoute: MealRoute?
    @State private var editingMeal: MealDetail?
    @State private var loadingEdit = false

    init(patientID: String, mealID: String, api: APIClient, actions: MealJournalActions, request: MealPageRequest? = nil, onRequestHandled: @escaping (UUID) -> Void = { _ in }) {
        _viewModel = StateObject(wrappedValue: MealOverviewViewModel(patientID: patientID, mealID: mealID, api: api))
        self.api = api
        self.actions = actions
        self.request = request
        self.onRequestHandled = onRequestHandled
    }

    public init(patientID: String, mealID: String, api: APIClient, actions: MealJournalActions) {
        self.init(patientID: patientID, mealID: mealID, api: api, actions: actions, request: nil)
    }

    private var route: MealRoute { MealRoute(patientID: viewModel.patientID, mealID: viewModel.mealID) }

    public var body: some View {
        Group {
            if let overview = viewModel.overview {
                page(overview)
            } else if let error = viewModel.loadErrorMessage {
                ContentUnavailableView("Posiłek", systemImage: "fork.knife", description: Text(error))
            } else {
                ProgressView("Wczytuję…")
            }
        }
        .navigationTitle(viewModel.overview?.item.displayTitle ?? "Posiłek")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await viewModel.load()
            carryOut(request)
        }
        // A push about this meal while its page is open (the same page, so the task above does not run again): read
        // it again, then open what the push asked for.
        .onChange(of: request?.id) { _, id in
            guard id != nil, let request else { return }
            Task {
                await viewModel.load()
                carryOut(request)
            }
        }
        .task(id: liveUpdates.map(ObjectIdentifier.init)) { viewModel.bindLiveUpdates(liveUpdates) }
        .sheet(item: $wbtRoute, onDismiss: { Task { await viewModel.load() } }) { route in
            MealWbtView(route: route, api: api) { wbtRoute = nil }
        }
        .sheet(item: $plannedPartRoute, onDismiss: { Task { await viewModel.load() } }) { route in
            PlannedBolusView(route: route, api: api) { plannedPartRoute = nil }
        }
        .sheet(item: $chatRoute, onDismiss: { Task { await viewModel.load() } }) { route in
            MealChatView(route: route, api: api) { chatRoute = nil }
        }
        .sheet(item: Binding(get: { editingMeal.map(IdentifiedMeal.init) }, set: { editingMeal = $0?.meal })) { wrapped in
            MealEditSheet(meal: wrapped.meal, proposal: nil) { edit in
                do {
                    try await MealEdit.apply(&edit, to: wrapped.meal, api: api, route: route)
                    await viewModel.load()
                    return .saved
                } catch {
                    return MealEditOutcome(error: error)
                }
            }
        }
        // A notification opening another screen closes these first (two sheets at once: the second is dropped).
        .closesForNotification(isPresented: wbtRoute != nil) { wbtRoute = nil }
        .closesForNotification(isPresented: plannedPartRoute != nil) { plannedPartRoute = nil }
        .closesForNotification(isPresented: chatRoute != nil) { chatRoute = nil }
        .closesForNotification(isPresented: editingMeal != nil) { editingMeal = nil }
        .alert("Posiłek", isPresented: Binding(get: { viewModel.errorMessage != nil && viewModel.overview != nil }, set: { if !$0 { viewModel.clearError() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    private func page(_ overview: MealOverview) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(overview.item.displayTitle)
                        .font(.title3.weight(.bold))
                    Text(meta(overview.item))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 8) {
                    MealOverviewChart(overview: overview)
                        .frame(height: 200)
                    MealOverviewChartLegend(overview: overview)
                }
                .padding(.vertical, 4)
                stats(overview)
            }

            if let due = viewModel.dueReminder {
                Section {
                    Label("Teraz: \(due.title.lowercased())", systemImage: "bell.badge.fill")
                        .foregroundStyle(MealJournalStyle.reminder)
                        .font(.subheadline.weight(.semibold))
                    if let given = overview.given_since_start, !given.line.isEmpty {
                        Text(given.line)
                            .font(.footnote.weight(given.anyGiven ? .semibold : .regular))
                            .foregroundStyle(given.anyGiven ? Color.orange : Color.secondary)
                    }
                    HStack(spacing: 10) {
                        if due.kind == .plannedPart {
                            // The planned part is given as itself (its dose now: the carbs / ICR now minus what the
                            // loop added), not as a new bolus.
                            Button("Podaj dawkę") { openPlannedPart(due.id) }
                                .buttonStyle(.borderedProminent)
                        } else {
                            Button("Podaj w Bolusie") { actions.openBolusTab() }
                                .buttonStyle(.borderedProminent)
                        }
                        Button("Zapytaj w czacie") { askInChat(overview) }
                            .buttonStyle(.bordered)
                    }
                }
            }

            if let excess = overview.dose_excess {
                Section {
                    Label(excess.message, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.orange)
                }
            }

            plannedPartsSection(overview)

            Section("Oś czasu") {
                CardDoseTimeline(
                    steps: MealJournalTimeline.steps(item: overview.item, boluses: overview.boluses, loopSystem: loopSystem),
                    onAction: { action in
                        guard case let .setMealReminder(_, reminderID, enabled) = action else { return }
                        Task { await viewModel.setReminder(id: reminderID, enabled: enabled) }
                    },
                    busySwitches: Set(viewModel.togglingIDs.map { "\(viewModel.mealID)/\($0)" })
                )
                .padding(.vertical, 6)
            }

            wbtSection(overview)

            mealSection(overview)

            if let conversationID = overview.item.conversation_id {
                Section {
                    Button {
                        actions.openConversation(conversationID)
                    } label: {
                        Label("Rozmowa, w której powstał posiłek", systemImage: "bubble.left.and.bubble.right")
                    }
                }
            }
        }
        .refreshable { await viewModel.load() }
    }

    /// Planned parts still to come: each opens its card, where it can be given earlier or switched off.
    @ViewBuilder
    private func plannedPartsSection(_ overview: MealOverview) -> some View {
        let waiting = overview.item.reminders.filter { $0.kind == .plannedPart && $0.status == .waiting }
        if !waiting.isEmpty {
            Section {
                ForEach(waiting) { reminder in
                    Button {
                        openPlannedPart(reminder.id)
                    } label: {
                        HStack {
                            Label(plannedPartLine(reminder), systemImage: "clock")
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .tint(.primary)
                }
            } footer: {
                Text("Możesz ją podać wcześniej albo wyłączyć.")
            }
        }
    }

    /// "Druga część bolusa · o 14:40", "Druga część bolusa · gdy glukoza zacznie rosnąć".
    private func plannedPartLine(_ reminder: MealJournalReminder) -> String {
        // A glucose condition in words (the reminder carries no threshold, so a threshold one shows its earliest time).
        let trigger = reminder.trigger ?? ""
        let condition = ["GLUCOSE_STOPPED_FALLING", "GLUCOSE_RISING"].contains(trigger)
            ? LaterTriggerText.condition(trigger: trigger, thresholdMgdl: nil) : nil
        let when = condition ?? reminder.dueDate.map { "o \(MealJournalFormat.clock($0))" }
        return [reminder.title, when].compactMap { $0 }.joined(separator: " · ")
    }

    /// Opens what a push asked for once the page is read; the request is forgotten either way (a page that did not load
    /// shows its error, and a later visit must not open the window).
    private func carryOut(_ request: MealPageRequest?) {
        guard let request else { return }
        onRequestHandled(request.id)
        guard let overview = viewModel.overview else { return }
        if request.opensWbt, overview.item.has_macros {
            wbtRoute = MealRoute(patientID: route.patientID, mealID: route.mealID, opensWbt: true)
        } else if request.opensPlannedBolus {
            openPlannedPart(request.plannedBolusID)
        }
    }

    /// The planned part's card (nil: the meal's current part).
    private func openPlannedPart(_ plannedBolusID: String?) {
        plannedPartRoute = MealRoute(patientID: route.patientID, mealID: route.mealID, opensPlannedBolus: true, plannedBolusID: plannedBolusID)
    }

    /// WBT, right under the timeline: the reminder 2.5 h after the meal (always offered while it can still come), then
    /// the dose worked out from protein and fat, or what it needs first.
    @ViewBuilder
    private func wbtSection(_ overview: MealOverview) -> some View {
        let reminder = overview.item.reminders.first { $0.kind == .wbt }
        let state = MealWbtReminderState(reminder: reminder, mealStart: overview.item.startedDate, now: Date())
        Section("WBT") {
            Toggle(isOn: Binding(
                get: { state.isOn },
                set: { on in Task { await viewModel.setReminder(id: "wbt", enabled: on) } }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Przypomnij o WBT")
                    if let note = state.note {
                        Text(note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .tint(.accentColor)
            .disabled(!state.canSwitch || viewModel.togglingIDs.contains("wbt"))

            if overview.item.has_macros {
                Button {
                    wbtRoute = MealRoute(patientID: route.patientID, mealID: route.mealID, opensWbt: true)
                } label: {
                    Label("Policz dawkę na WBT", systemImage: "function")
                }
            } else {
                Label {
                    Text("Do policzenia dawki na WBT potrzebne są białko i tłuszcz. Uzupełnij posiłek poniżej: w czacie posiłku albo ręcznie.")
                } icon: {
                    Image(systemName: "info.circle")
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.vertical, 4)
            }
        }
    }

    /// What was eaten: the description and its values, written in the meal's chat (or typed by hand). One block.
    @ViewBuilder
    private func mealSection(_ overview: MealOverview) -> some View {
        let description = (overview.description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        Section("Posiłek") {
            VStack(alignment: .leading, spacing: 12) {
                if description.isEmpty {
                    Text("Opisz posiłek. Policzę węglowodany, białko i tłuszcz, a z nich dawkę na WBT.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text(description)
                    if let macros = overview.macros {
                        MealMacroChips(macros: macros)
                    }
                }
                HStack(spacing: 12) {
                    Button {
                        chatRoute = route
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "bubble.left.fill")
                            Text(description.isEmpty ? "Opisz w czacie" : "Czat posiłku")
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    Spacer(minLength: 0)
                    Button(description.isEmpty ? "Wpisz ręcznie" : "Edytuj ręcznie") { Task { await openEditor() } }
                        .buttonStyle(.borderless)
                        .font(.subheadline)
                        .disabled(loadingEdit)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func meta(_ item: MealJournalItem) -> String {
        guard let start = item.startedDate else { return "" }
        let day = MealJournalFormat.dayTitle(Calendar.current.startOfDay(for: start))
        let source: String? = switch item.source {
        case .chat: "z czatu"
        case .bolusScreen: "zakładka Bolus"
        case .other: nil
        }
        return [day, MealJournalFormat.clock(start), source].compactMap { $0 }.joined(separator: " · ")
    }

    private func stats(_ overview: MealOverview) -> some View {
        HStack {
            stat(overview.item.carbs_g.map { "\(MealJournalFormat.number($0)) g" } ?? "—", "węglowodany")
            stat(overview.item.insulin_total_u.map { "\(MealJournalFormat.number($0)) j" } ?? "0 j", "insulina razem")
            stat(overview.peakGlucose.map { "\(Int($0.rounded()))" } ?? "—", "najwyżej")
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.headline.monospacedDigit())
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func askInChat(_ overview: MealOverview) {
        if let conversationID = overview.item.conversation_id {
            actions.openConversation(conversationID)
        } else {
            actions.openNewChat()
        }
    }

    /// The edit sheet needs the meal's full record (macros with their trust, revision).
    private func openEditor() async {
        loadingEdit = true
        defer { loadingEdit = false }
        editingMeal = try? await api.getMeal(patientID: viewModel.patientID, mealID: viewModel.mealID).meal
    }
}

private struct IdentifiedMeal: Identifiable {
    let meal: MealDetail
    var id: String { meal.meal_id }
}

/// "Węglowodany 23 g · Białko 9 g · Tłuszcz 7,3 g" as small chips.
struct MealMacroChips: View {
    let macros: MealMacros

    var body: some View {
        HStack(spacing: 6) {
            chip("Węglowodany", macros.carbs.grams)
            chip("Białko", macros.protein.grams)
            chip("Tłuszcz", macros.fat.grams)
        }
    }

    @ViewBuilder
    private func chip(_ label: String, _ grams: Double?) -> some View {
        if let grams {
            VStack(spacing: 1) {
                Text("\(MealJournalFormat.number(grams)) g").font(.subheadline.weight(.semibold).monospacedDigit())
                Text(label).font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Glucose from 30 min before the meal to now (at most 6 h after), the doses as labelled marks along the top, carb
/// entries alone in orange, boluses on no meal outlined, reminders still to come as dashed lines.
struct MealOverviewChart: View {
    let overview: MealOverview
    var now = Date()

    var body: some View {
        let points = overview.glucose.compactMap { reading in reading.date.map { (date: $0, value: reading.value) } }
        let start = overview.item.startedDate ?? points.first?.date ?? now
        let end = min(start.addingTimeInterval(6 * 3600), max(now, start.addingTimeInterval(2 * 3600)))
        let from = start.addingTimeInterval(-30 * 60)
        let top = max(260, (points.map(\.value).max() ?? 0) + 30)
        let marks = overview.boluses.compactMap { bolus in bolus.date.map { (date: $0, bolus: bolus) } }
        let others = overview.other_boluses.compactMap { bolus in bolus.date.map { (date: $0, units: bolus.insulin_u ?? 0) } }
            .filter { $0.date >= from && $0.date <= end && $0.units > 0 }
        let reminders = overview.item.reminders.filter { $0.isPending && !$0.isRising }.compactMap { reminder in reminder.dueDate.map { (date: $0, reminder: reminder) } }
        Chart {
            RectangleMark(xStart: .value("od", from), xEnd: .value("do", end), yStart: .value("min", 70), yEnd: .value("max", 180))
                .foregroundStyle(Color.green.opacity(0.08))
            // By position: two readings at the same moment (a duplicate upload) would share a date.
            ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                LineMark(x: .value("Czas", point.date), y: .value("Glukoza", point.value))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(Color.primary)
            }
            ForEach(Array(marks.enumerated()), id: \.offset) { _, mark in
                let insulin = (mark.bolus.insulin_u ?? 0) > 0
                RuleMark(x: .value("Wpis", mark.date))
                    .foregroundStyle((insulin ? MealJournalStyle.bolus : Color.orange).opacity(0.35))
                    .lineStyle(StrokeStyle(lineWidth: 1.5))
                PointMark(x: .value("Wpis", mark.date), y: .value("Góra", top))
                    .symbolSize(0)
                    .annotation(position: .bottom, spacing: 2) {
                        Text(insulin ? "\(MealJournalFormat.number(mark.bolus.insulin_u ?? 0)) j" : "\(MealJournalFormat.number(mark.bolus.carbs_g ?? 0)) g")
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(insulin ? MealJournalStyle.bolus : Color.orange))
                    }
            }
            // Not this meal's: the same blue, outlined, so the meal's own insulin still reads first.
            ForEach(Array(others.enumerated()), id: \.offset) { _, other in
                RuleMark(x: .value("Inny bolus", other.date))
                    .foregroundStyle(MealJournalStyle.bolus.opacity(0.25))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [2, 2]))
                PointMark(x: .value("Inny bolus", other.date), y: .value("Góra", top))
                    .symbolSize(0)
                    .annotation(position: .bottom, spacing: 2) {
                        Text("\(MealJournalFormat.number(other.units)) j")
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(MealJournalStyle.bolus)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(MealJournalStyle.card))
                            .overlay(Capsule().strokeBorder(MealJournalStyle.bolus, lineWidth: 1))
                    }
            }
            ForEach(reminders, id: \.reminder.id) { item in
                RuleMark(x: .value("Przypomnienie", item.date))
                    .foregroundStyle(MealJournalStyle.reminder)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXScale(domain: from...end)
        .chartYScale(domain: 40...top)
        .chartXAxis {
            // Every hour up to 3 h, every second hour beyond: six labels do not fit the phone's width.
            AxisMarks(values: .stride(by: .hour, count: end.timeIntervalSince(from) > 3.5 * 3600 ? 2 : 1)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            }
        }
        .chartYAxis {
            AxisMarks(values: [70, 180]) { _ in
                AxisGridLine()
                AxisValueLabel()
            }
        }
    }
}

/// What the marks mean, and readings missing since a time.
struct MealOverviewChartLegend: View {
    let overview: MealOverview
    var now = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                legend(color: MealJournalStyle.bolus, text: "bolus")
                if overview.boluses.contains(where: { ($0.insulin_u ?? 0) <= 0 }) {
                    legend(color: .orange, text: "wpis węglowodanów")
                }
                if overview.other_boluses.contains(where: { ($0.insulin_u ?? 0) > 0 }) {
                    HStack(spacing: 4) {
                        Capsule().strokeBorder(MealJournalStyle.bolus, lineWidth: 1).frame(width: 10, height: 6)
                        Text("bolus bez posiłku")
                    }
                }
                if overview.item.reminders.contains(where: { $0.isPending && !$0.isRising }) {
                    HStack(spacing: 4) {
                        Rectangle().fill(MealJournalStyle.reminder).frame(width: 10, height: 1.5)
                        Text("przypomnienie")
                    }
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            if let last = overview.glucose.compactMap(\.date).max(), now.timeIntervalSince(last) > 15 * 60,
               let start = overview.item.startedDate, now < start.addingTimeInterval(6 * 3600) {
                Label("Brak odczytów CGM od \(MealJournalFormat.clock(last))", systemImage: "antenna.radiowaves.left.and.right.slash")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func legend(color: Color, text: String) -> some View {
        HStack(spacing: 4) {
            Capsule().fill(color).frame(width: 10, height: 6)
            Text(text)
        }
    }
}

private extension View {
    /// Keeps the view's laid-out height in `height` (the tile animates between measured heights).
    func measuredHeight(_ height: Binding<CGFloat>) -> some View {
        background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { height.wrappedValue = proxy.size.height }
                    .onChange(of: proxy.size.height) { _, value in height.wrappedValue = value }
            }
        }
    }
}

/// Which tiles are in view, kept outside SwiftUI's state: only a change of the top day reaches the view model.
@MainActor
final class VisibleMeals {
    private var days: [String: Date] = [:]
    private var top: Date?
    var onTopDayChange: ((Set<Date>) -> Void)?

    func set(_ id: String, day: Date?) {
        days[id] = day
        let newTop = days.values.max()
        guard newTop != top else { return }
        top = newTop
        onTopDayChange?(Set(days.values))
    }
}

/// Keeps which tiles are in view (iOS 18: almost all of the tile, one half under the calendar does not count; before:
/// appear and disappear).
private struct TracksVisibility: ViewModifier {
    let id: String
    let day: Date
    let visible: VisibleMeals

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollVisibilityChange(threshold: 0.8) { shown in
                visible.set(id, day: shown ? day : nil)
            }
        } else {
            content
                .onAppear { visible.set(id, day: day) }
                .onDisappear { visible.set(id, day: nil) }
        }
    }
}
