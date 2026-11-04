import Charts
import SwiftUI

/// What the Meals tab hands back to the app: open a conversation, the Bolus tab, or a new chat.
public struct MealJournalActions {
    public var openConversation: (String) -> Void
    public var openBolusTab: () -> Void
    public var openNewChat: () -> Void
    /// A new chat with this text ready to send ("Nowy podział w czacie" after "Scal").
    public var openNewChatWithText: (String) -> Void

    public init(
        openConversation: @escaping (String) -> Void,
        openBolusTab: @escaping () -> Void,
        openNewChat: @escaping () -> Void,
        openNewChatWithText: ((String) -> Void)? = nil
    ) {
        self.openConversation = openConversation
        self.openBolusTab = openBolusTab
        self.openNewChat = openNewChat
        self.openNewChatWithText = openNewChatWithText ?? { _ in openNewChat() }
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
    /// The list is moving: a row held when the scroll began drops its highlight (iOS does not end the hold for it).
    @State private var isScrolling = false
    /// "Opisz" on a tile: the meal's chat in a sheet.
    @State private var describeRoute: MealRoute?
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
                .modifier(TracksScrolling(isScrolling: $isScrolling))
                // The calendar stays above the list while it scrolls, marking the day at the top.
                .safeAreaInset(edge: .top, spacing: 0) {
                    // "Brak posiłków …" just under the calendar, over the list.
                    calendarHeader.overlay(alignment: .bottom) {
                        dayNoteBubble.alignmentGuide(.bottom) { $0[.top] }
                    }
                }
                // A merge: the merged meal comes into view (its mark plays where it can be seen).
                .onChange(of: viewModel.justMergedMealID) { _, mealID in
                    guard let mealID else { return }
                    withAnimation(.snappy(duration: 0.4)) { proxy.scrollTo(mealID, anchor: .center) }
                }
                .onChange(of: viewModel.scrollRequest) { _, request in
                    guard let request else { return }
                    withAnimation(.snappy(duration: 0.35)) { proxy.scrollTo(request.day, anchor: .top) }
                }
                .onAppear { visibleMeals.onTopDayChange = { [weak viewModel] days in viewModel?.visibleDaysChanged(days) } }
            }
            // Hidden while ticking meals, never taken off: switching the modifier would rebuild the list and scroll it to the top.
            .modifier(MealSearchField(isOn: searchable, hidden: viewModel.isSelecting, query: $viewModel.query))
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if viewModel.isSelecting { mergeBar }
            }
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
                    if viewModel.isSelecting {
                        Button("Anuluj") { viewModel.cancelSelecting() }
                            .disabled(viewModel.isMerging)
                    } else {
                        Button("Dziś") {
                            Task { await viewModel.goToToday() }
                        }
                        .disabled(viewModel.isSelectedDayToday)
                    }
                }
                if !viewModel.isSelecting, !viewModel.isSearchActive, !viewModel.items.isEmpty {
                    ToolbarItem(placement: .navigation) {
                        Button("Scal") { viewModel.startSelecting() }
                            .accessibilityHint("Zaznacz posiłki, które mają być jednym posiłkiem.")
                    }
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
            .modifier(ListPullToRefresh(pull: pull) {
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
        .alert("Scalić posiłki?", isPresented: mergeQuestionBinding(.confirmReset)) {
            Button("Scal i wpisz od nowa", role: .destructive) {
                Task { await viewModel.confirmMergeReset() }
            }
            Button("Anuluj", role: .cancel) { viewModel.cancelMergeQuestion() }
        } message: {
            Text(MealMergeText.resetQuestion)
        }
        .alert("Rozłożony bolus", isPresented: mergeQuestionBinding(.chooseSplit)) {
            Button("Zostaw podział") {
                Task { await viewModel.chooseMergeSplit(.keep) }
            }
            Button("Nowy podział w czacie") {
                Task { await viewModel.chooseMergeSplit(.resplit) }
            }
            Button("Anuluj", role: .cancel) { viewModel.cancelMergeQuestion() }
        } message: {
            Text(MealMergeText.splitQuestion)
        }
        .onChange(of: viewModel.mergeChatRequest) { _, request in
            guard let request else { return }
            viewModel.mergeChatHandled(request)
            actions.openNewChatWithText(request.text)
        }
        .onChange(of: viewModel.mergedMealToDescribe) { _, mealID in
            guard let mealID else { return }
            viewModel.mergedMealHandled()
            path = [mealID]
        }
        .sheet(item: $describeRoute, onDismiss: { Task { await viewModel.load() } }) { route in
            MealChatView(route: route, api: api, closesAfterAccept: true) { describeRoute = nil }
        }
        .closesForNotification(isPresented: describeRoute != nil) { describeRoute = nil }
    }

    private func mergeQuestionBinding(_ question: MealJournalViewModel.MergeQuestion) -> Binding<Bool> {
        Binding(
            get: { viewModel.mergeQuestion == question },
            set: { shown in if !shown, viewModel.mergeQuestion == question { viewModel.cancelMergeQuestion() } }
        )
    }

    /// While ticking meals for "Scal": how many are ticked and the button that merges them.
    private var mergeBar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(MealMergeText.selectionLine(viewModel.selectedMealIDs.count))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if viewModel.hasMealsOutsideMergeWindow {
                    Text(MealMergeText.windowLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task { await viewModel.mergeSelected() }
            } label: {
                if viewModel.isMerging {
                    ProgressView().frame(minWidth: 64)
                } else {
                    Text("Scal").font(.body.weight(.semibold)).frame(minWidth: 64)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.interactive)
            .disabled(!viewModel.canMergeSelection)
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .glassBubble(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
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
                                },
                                onHold: viewModel.isSearchActive ? nil : {
                                    withAnimation(.snappy(duration: 0.25)) { viewModel.startSelecting(with: item.meal_id) }
                                },
                                onDescribe: viewModel.isSelecting ? nil : {
                                    describeRoute = MealRoute(patientID: viewModel.patientID, mealID: item.meal_id)
                                },
                                listScrolling: isScrolling
                            )
                            .modifier(MergeSelectable(
                                isSelecting: viewModel.isSelecting,
                                isSelected: viewModel.selectedMealIDs.contains(item.meal_id),
                                isSelectable: viewModel.canSelect(item),
                                toggle: { viewModel.toggleSelection(item.meal_id) },
                                startWithThis: { viewModel.startSelecting(with: item.meal_id) }
                            ))
                            .modifier(JustMergedHighlight(active: viewModel.justMergedMealID == item.meal_id) {
                                viewModel.mergedHighlightEnded(item.meal_id)
                            })
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .modifier(TracksVisibility(id: item.meal_id, day: day.day, visible: visibleMeals))
                            .id(item.meal_id)
                            // "Scal": a ticked meal shrinks away into the merged one.
                            .transition(.asymmetric(insertion: .opacity, removal: .scale(scale: 0.8).combined(with: .opacity)))
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

/// The meal a merge just made: its frame and a soft tint light up, pulse once and fade (about 2.5 s), with a light tap,
/// so it is clear which tile the ticked meals became. The ticked ones shrink away into it (the list's animation).
private struct JustMergedHighlight: ViewModifier {
    let active: Bool
    let onEnd: () -> Void
    @State private var glow: Double = 0

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Brand.interactive.opacity(0.10 * glow))
                    .padding(.horizontal, -10)
                    .padding(.vertical, -6)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Brand.interactive.opacity(0.9 * glow), lineWidth: 2)
                    .padding(.horizontal, -10)
                    .padding(.vertical, -6)
                    .allowsHitTesting(false)
            }
            .scaleEffect(1 + 0.015 * glow)
            .sensoryFeedback(.success, trigger: active) { _, now in now }
            .task(id: active) {
                guard active else {
                    glow = 0
                    return
                }
                // In after the others have folded away, one soft pulse, then a slow fade.
                try? await Task.sleep(for: .milliseconds(250))
                withAnimation(.easeOut(duration: 0.35)) { glow = 1 }
                try? await Task.sleep(for: .milliseconds(450))
                withAnimation(.easeInOut(duration: 0.3)) { glow = 0.45 }
                try? await Task.sleep(for: .milliseconds(300))
                withAnimation(.easeInOut(duration: 0.3)) { glow = 1 }
                try? await Task.sleep(for: .milliseconds(1_100))
                withAnimation(.easeOut(duration: 0.9)) { glow = 0 }
                try? await Task.sleep(for: .milliseconds(900))
                guard !Task.isCancelled else { return }
                onEnd()
            }
    }
}

/// "Scal": while meals are ticked, a tile is a tick box (a tap ticks it, its own buttons wait), with the circle before it.
/// A meal more than 4 hours from the ticked ones is greyed out, without a circle, and cannot be ticked. (Holding a
/// meal down to start it is the tile's own gesture, beside its tap.)
private struct MergeSelectable: ViewModifier {
    let isSelecting: Bool
    let isSelected: Bool
    let isSelectable: Bool
    let toggle: () -> Void
    let startWithThis: () -> Void

    /// One layout in both modes: switching between two would rebuild the row (its unfolded time line, the list's place).
    func body(content: Content) -> some View {
        // The tick sits over the row's chevron: nothing changes width, so no text wraps anew and the list keeps its place.
        content
            .allowsHitTesting(!isSelecting)
            .overlay(alignment: .topTrailing) {
                if isSelecting {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title2)
                        .foregroundStyle(isSelected ? Brand.interactive : Color.secondary)
                        .background(Circle().fill(MealJournalStyle.card).padding(-4))
                        .opacity(isSelectable ? 1 : 0)
                        .offset(x: 4, y: -2)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                        .accessibilityHidden(true)
                }
            }
        .opacity(isSelecting && !isSelectable ? 0.35 : 1)
        .animation(.easeInOut(duration: 0.2), value: isSelectable)
        .animation(.snappy(duration: 0.25), value: isSelecting)
        .overlay {
            // While ticking, the whole row is the tick box.
            if isSelecting {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { if isSelectable { toggle() } }
                    .accessibilityElement()
                    .accessibilityLabel(isSelected ? "Zaznaczony" : "Niezaznaczony")
                    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
                    .accessibilityHint(isSelectable ? "" : MealMergeText.windowLine)
            }
        }
        .accessibilityAction(named: "Scal z innymi posiłkami", startWithThis)
    }
}

/// Whether the list is being dragged or still moving (iOS 18+; on 17 a held row keeps its highlight until let go).
private struct TracksScrolling: ViewModifier {
    @Binding var isScrolling: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollPhaseChange { _, phase in isScrolling = phase.isScrolling }
        } else {
            content
        }
    }
}

/// The words of "Scal" (meal-merge.v1).
enum MealMergeText {
    static let resetQuestion = "Kilka z zaznaczonych posiłków ma własny opis albo wartości (węglowodany, białko, tłuszcz). "
        + "Po scaleniu zostaną usunięte i trzeba je będzie wpisać od nowa w scalonym posiłku. Bolusy i przypomnienia zostaną zachowane."
    static let splitQuestion = "Jeden z zaznaczonych posiłków ma rozłożony bolus i czeka na kolejną część. "
        + "Możesz zostawić ten podział bez zmian albo przejść do czatu i ustalić nowy podział dla całego scalonego posiłku. "
        + "Wtedy zaplanowana kolejna część zostanie pominięta."

    static let windowLine = "Wyszarzonych nie można scalić: są ponad 4 godziny od zaznaczonych."

    static func selectionLine(_ count: Int) -> String {
        switch count {
        case 0: return "Zaznacz posiłki do scalenia."
        case 1: return "Zaznaczono 1 posiłek."
        default: return "Zaznaczono \(count) \(PolishPlural.meals(count))."
        }
    }
}

enum PolishPlural {
    /// "2 posiłki", "5 posiłków", "22 posiłki".
    static func meals(_ count: Int) -> String {
        let tens = count % 100
        let ones = count % 10
        if (2...4).contains(ones), !(12...14).contains(tens) { return "posiłki" }
        return count == 1 ? "posiłek" : "posiłków"
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
    /// "Scal" in progress: the bar's own place, the capsule is not shown.
    var hidden = false
    @Binding var query: String
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        if isOn {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                if !hidden {
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
            }
        } else {
            content
        }
    }
}

enum MealJournalStyle {
    static let reminder = Color(red: 0.557, green: 0.361, blue: 0.969)
    /// The dashboard chart's bolus blue, for marks and text on the card: the light mode's blue is only 3.7:1 on the dark card.
    static let bolus = Brand.dynamic(light: 0x0A6CFF, dark: 0x409CFF)
    /// Under white text the darker blue stays in both modes (4.6:1; the dark mode's lighter one would be 2.8:1).
    static let bolusFill = Brand.rgb(0x0A6CFF)
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
    /// Held down for half a second: "Scal" starts with this meal ticked (nil: no hold, e.g. search results).
    var onHold: (() -> Void)? = nil
    /// "Opisz" beside the title of a meal not described yet: its chat (nil: no chip, e.g. while ticking meals).
    var onDescribe: (() -> Void)? = nil
    /// The list is moving: a press that began a scroll drops its highlight (iOS does not always end it).
    var listScrolling = false
    /// A finger rests on the row before the hold: a soft highlight says it is being held.
    @State private var pressing = false
    @State private var holds = 0
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
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.displayTitle)
                            .font(.body.weight(.semibold))
                            .lineLimit(1)
                        Text(statsLine)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if item.needsDescription, let onDescribe {
                        Spacer(minLength: 0)
                        Button(action: onDescribe) {
                            Label("Opisz", systemImage: "bubble.left.fill")
                                .font(.footnote.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Brand.interactive.opacity(0.14), in: Capsule())
                                .foregroundStyle(Brand.interactive)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityHint("Otwiera czat posiłku: policzę makro i WBT")
                    }
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
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Brand.interactive.opacity(pressing ? 0.10 : 0))
                .padding(.horizontal, -10)
                .padding(.vertical, -6)
        }
        .scaleEffect(pressing ? 0.98 : 1)
        .animation(.easeOut(duration: pressing ? 0.35 : 0.15), value: pressing)
        .contentShape(Rectangle())
        // Tap and hold on the same view, the tap first: so the list still scrolls and the hold is not lost to the tap.
        .onTapGesture(perform: onOpen)
        .onLongPressGesture(minimumDuration: 0.5, maximumDistance: 10) {
            guard let onHold else { return }
            pressing = false
            holds += 1
            onHold()
        } onPressingChanged: { held in
            pressing = held && onHold != nil && !listScrolling
        }
        .onChange(of: listScrolling) { _, scrolling in if scrolling { pressing = false } }
        .sensoryFeedback(.impact(weight: .medium), trigger: holds)
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
    /// The title in the page has scrolled away: the bar shows it instead.
    @State private var titleScrolledAway = false

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
        .navigationTitle(viewModel.overview?.pageTitle ?? "Posiłek")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let overview = viewModel.overview {
                ToolbarItem(placement: .principal) {
                    Text(overview.pageTitle)
                        .font(.headline)
                        .lineLimit(1)
                        .opacity(titleScrolledAway ? 1 : 0)
                        .animation(.easeInOut(duration: 0.15), value: titleScrolledAway)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Edytuj ręcznie", systemImage: "pencil") { Task { await openEditor() } }
                            .disabled(loadingEdit)
                        if let conversationID = overview.item.conversation_id {
                            Button("Rozmowa, w której powstał posiłek", systemImage: "bubble.left.and.bubble.right") {
                                actions.openConversation(conversationID)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("Więcej")
                }
            }
        }
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

    /// What needs a decision first, then the meal: while something is to come the course comes before the food, after
    /// it the food comes first. A meal nothing is known about leads with describing it.
    private func page(_ overview: MealOverview) -> some View {
        let active = MealJournalTimeline.isOpen(overview.item)
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(overview)
                if let excess = overview.dose_excess {
                    Label(excess.message, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.orange)
                        .mealPageCard(tint: .orange)
                }
                if let due = viewModel.dueReminder {
                    actionCard(due, overview: overview)
                }
                if overview.isUndescribed {
                    describeCard
                }
                glanceCard(overview)
                if active {
                    progressCard(overview)
                    if !overview.isUndescribed { foodCard(overview) }
                } else {
                    if !overview.isUndescribed { foodCard(overview) }
                    progressCard(overview)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(MealJournalStyle.page)
        .refreshable { await viewModel.load() }
    }

    private func header(_ overview: MealOverview) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let start = overview.item.startedDate {
                Text("\(MealJournalFormat.dayTitle(Calendar.current.startOfDay(for: start))), \(MealJournalFormat.clock(start))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(overview.pageTitle)
                .font(.title.weight(.bold))
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, 4)
        .onGeometryChange(for: Bool.self) { $0.frame(in: .scrollView).maxY < 0 } action: { titleScrolledAway = $0 }
    }

    /// The reminder that came. Insulin given since the meal's start turns the card amber and takes the emphasis off
    /// giving another dose: the two buttons weigh the same.
    private func actionCard(_ due: MealJournalReminder, overview: MealOverview) -> some View {
        let given = overview.given_since_start
        let warned = given?.anyGiven == true
        let tint: Color = warned ? .orange : MealJournalStyle.reminder
        return VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(due.dueTitle)
                    .font(.title3.weight(.bold))
                if let line = given?.cardLine, !line.isEmpty {
                    if warned {
                        Label(line, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.orange)
                    } else {
                        Text(line)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            let giveTitle = due.kind == .plannedPart ? "Podaj dawkę" : "Podaj w Bolusie"
            // The planned part is given as itself (its dose now: the carbs / ICR now minus what the loop added), not
            // as a new bolus.
            let give = { due.kind == .plannedPart ? openPlannedPart(due.id) : actions.openBolusTab() }
            if warned {
                HStack(spacing: 8) {
                    Button(action: give) { Text(giveTitle).frame(maxWidth: .infinity) }
                    Button { askInChat(overview) } label: { Text("Zapytaj w czacie").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .tint(.orange)
                .font(.subheadline.weight(.semibold))
            } else {
                VStack(spacing: 4) {
                    Button(action: give) {
                        Text(giveTitle).fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    Button { askInChat(overview) } label: {
                        Text("Zapytaj w czacie").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderless)
                    .tint(.primary)
                }
            }
        }
        .mealPageCard(tint: tint)
    }

    private var describeCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Opisz posiłek")
                    .font(.title3.weight(.bold))
                Text("Policzę węglowodany, białko i tłuszcz, a z nich dawkę na WBT.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            VStack(spacing: 4) {
                Button { chatRoute = route } label: {
                    Text("Opisz w czacie").fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Button { Task { await openEditor() } } label: {
                    Text("Wpisz ręcznie").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderless)
                .tint(.primary)
                .disabled(loadingEdit)
            }
        }
        .mealPageCard(tint: .accentColor)
    }

    /// The numbers and the chart, one block.
    private func glanceCard(_ overview: MealOverview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 4) {
                stat(overview.item.carbs_g.map { "\(MealJournalFormat.number($0)) g" } ?? "—", "węglowodany")
                stat(overview.item.insulin_total_u.map { "\(MealJournalFormat.number($0)) j" } ?? "0 j", "insulina")
                stat(overview.peakGlucose.map { "\(Int($0.rounded()))" } ?? "—", "najwyżej")
                stat(overview.lowestGlucose.map { "\(Int($0.rounded()))" } ?? "—", "najniżej")
            }
            MealOverviewChart(overview: overview)
                .frame(height: 190)
            MealOverviewCGMNote(overview: overview)
        }
        .mealPageCard()
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.headline.monospacedDigit())
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// Given, waiting and to come on one list; WBT's reminder, its switch and its dose are one row.
    private func progressCard(_ overview: MealOverview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Przebieg")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            ForEach(MealPageProgress.rows(overview, loopSystem: loopSystem)) { row in
                MealPageRowView(
                    row: row,
                    isBusy: row.switchReminderID.map(viewModel.togglingIDs.contains) ?? false,
                    onSwitch: { id, on in Task { await viewModel.setReminder(id: id, enabled: on) } },
                    onOpenPlannedPart: { openPlannedPart($0) },
                    onWbtDose: { wbtRoute = MealRoute(patientID: route.patientID, mealID: route.mealID, opensWbt: true) }
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .mealPageCard()
    }

    /// What was eaten: the description and its values, written in the meal's chat (or typed by hand).
    private func foodCard(_ overview: MealOverview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if let line = overview.descriptionLine {
                Text(line)
            }
            if let macros = overview.macros {
                MealMacroSummary(macros: macros)
            }
            HStack(spacing: 8) {
                Button { chatRoute = route } label: {
                    Text("Czat posiłku").frame(maxWidth: .infinity)
                }
                Button { Task { await openEditor() } } label: {
                    Text("Edytuj ręcznie").frame(maxWidth: .infinity)
                }
                .disabled(loadingEdit)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .font(.subheadline.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .mealPageCard()
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
private extension View {
    /// A card of the meal's page: the plain card, or tinted when it asks for something.
    func mealPageCard(tint: Color? = nil) -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
                if let tint { shape.fill(tint.opacity(0.18)) } else { shape.fill(MealJournalStyle.card) }
            }
    }
}

/// One line of "Przebieg".
private struct MealPageRowView: View {
    let row: MealPageRow
    let isBusy: Bool
    let onSwitch: (String, Bool) -> Void
    let onOpenPlannedPart: (String) -> Void
    let onWbtDose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let partID = row.plannedPartID {
                Button { onOpenPlannedPart(partID) } label: {
                    line {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .tint(.primary)
            } else {
                line {
                    if let id = row.switchReminderID {
                        Toggle(isOn: Binding(get: { row.isOn }, set: { onSwitch(id, $0) })) {
                            Text("Przypomnij: \(row.title)")
                        }
                        .labelsHidden()
                        .tint(.accentColor)
                        .disabled(isBusy)
                    }
                }
            }
            if row.offersWbtDose {
                Button("Policz dawkę na WBT", action: onWbtDose)
                    .buttonStyle(.bordered)
                    .font(.subheadline.weight(.semibold))
                    .padding(.leading, 34)
            }
        }
    }

    private func line<Trailing: View>(@ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .top, spacing: 12) {
            icon
                .font(.title3)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body.weight(.semibold).monospacedDigit())
                    .foregroundStyle(row.state == .off ? .secondary : .primary)
                if let note = row.note {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(row.state == .due ? MealJournalStyle.reminder : .secondary)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 4)
            trailing()
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var icon: some View {
        switch row.state {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .due: Image(systemName: "circle.inset.filled").foregroundStyle(MealJournalStyle.reminder)
        case .planned: Image(systemName: "circle.dotted").foregroundStyle(.secondary)
        case .off: Image(systemName: "bell.slash").foregroundStyle(.secondary).font(.subheadline)
        }
    }
}

/// The meal's carbs, protein and fat, with their shares of its energy above them (a fatty meal shows at once).
struct MealMacroSummary: View {
    let macros: MealMacros

    private static let carbsColor = Color.orange
    private static let proteinColor = Color.cyan
    private static let fatColor = Color.yellow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let shares = Self.energyShares(carbs: macros.carbs.grams, protein: macros.protein.grams, fat: macros.fat.grams)
            if !shares.isEmpty {
                GeometryReader { proxy in
                    let gaps = CGFloat(shares.count - 1) * 3
                    HStack(spacing: 3) {
                        ForEach(shares, id: \.kind) { share in
                            Capsule()
                                .fill(Self.color(share.kind))
                                .frame(width: max(0, proxy.size.width - gaps) * share.value)
                        }
                    }
                }
                .frame(height: 8)
                .accessibilityHidden(true)
            }
            HStack(alignment: .top, spacing: 4) {
                value("węglowodany", macros.carbs.grams, Self.carbsColor)
                value("białko", macros.protein.grams, Self.proteinColor)
                value("tłuszcz", macros.fat.grams, Self.fatColor)
            }
        }
    }

    private static func color(_ kind: EnergyShare.Kind) -> Color {
        switch kind {
        case .carbs: return carbsColor
        case .protein: return proteinColor
        case .fat: return fatColor
        }
    }

    @ViewBuilder
    private func value(_ label: String, _ grams: Double?, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(grams.map { "\(MealJournalFormat.number($0)) g" } ?? "—")
                .font(.headline.monospacedDigit())
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
                Text(label).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct EnergyShare: Equatable {
    enum Kind: Equatable { case carbs, protein, fat }
    let kind: Kind
    /// 0...1 of the meal's energy.
    let value: Double
}

extension MealMacroSummary {
    /// Shares of the energy (carbs and protein 4 kcal/g, fat 9 kcal/g), the known non-zero ones; none with one value or
    /// fewer: a single full bar says nothing.
    static func energyShares(carbs: Double?, protein: Double?, fat: Double?) -> [EnergyShare] {
        let energy: [(EnergyShare.Kind, Double)] = [(.carbs, (carbs ?? 0) * 4), (.protein, (protein ?? 0) * 4), (.fat, (fat ?? 0) * 9)]
        let known = energy.filter { $0.1 > 0 }
        let total = known.reduce(0) { $0 + $1.1 }
        guard known.count > 1, total > 0 else { return [] }
        return known.map { EnergyShare(kind: $0.0, value: $0.1 / total) }
    }
}

/// Glucose from 30 min before the meal, as far as what is still to come (at most 6 h after the meal). Every mark says
/// what it is on the chart itself: doses along the top, carb entries alone in orange, boluses on no meal outlined,
/// reminders in violet (filled when their moment came, outlined and dashed before it).
struct MealOverviewChart: View {
    let overview: MealOverview
    var now = Date()

    private struct Mark {
        enum Style { case dose, carbs, otherDose, reminderDue, reminderPlanned }
        let date: Date
        let text: String
        let style: Style
        var isReminder: Bool { style == .reminderDue || style == .reminderPlanned }
    }

    private var marks: [Mark] {
        var marks: [Mark] = overview.boluses.compactMap { bolus in
            guard let date = bolus.date else { return nil }
            let insulin = bolus.insulin_u ?? 0
            return insulin > 0
                ? Mark(date: date, text: "\(MealJournalFormat.number(insulin)) j", style: .dose)
                : Mark(date: date, text: "\(MealJournalFormat.number(bolus.carbs_g ?? 0)) g", style: .carbs)
        }
        marks += overview.other_boluses.compactMap { bolus in
            guard let date = bolus.date, let insulin = bolus.insulin_u, insulin > 0 else { return nil }
            return Mark(date: date, text: "\(MealJournalFormat.number(insulin)) j", style: .otherDose)
        }
        for reminder in overview.item.reminders where !reminder.isRising {
            if reminder.isPending, let date = reminder.dueDate {
                marks.append(Mark(date: date, text: Self.reminderLabel(reminder), style: .reminderPlanned))
            } else if reminder.status == .dueNow, let date = reminder.fired_at.flatMap(ServerDate.parse) ?? reminder.dueDate {
                marks.append(Mark(date: date, text: Self.reminderLabel(reminder), style: .reminderDue))
            }
        }
        return marks
    }

    var body: some View {
        let points = overview.glucose.compactMap { reading in reading.date.map { (date: $0, value: reading.value) } }
        let start = overview.item.startedDate ?? points.first?.date ?? now
        let pending = overview.item.reminders.filter { $0.isPending && !$0.isRising }.compactMap(\.dueDate)
        let window = Self.window(start: start, pending: pending, now: now)
        let top = max(260, (points.map(\.value).max() ?? 0) + 30)
        let active = MealJournalTimeline.isOpen(overview.item)
        let shown = marks.filter { $0.date >= window.lowerBound && $0.date <= window.upperBound }
        // Doses along the top, reminders along the bottom: a label stays on its own line, whatever is close to it.
        let span = window.upperBound.timeIntervalSince(window.lowerBound)
        let doses = shown.filter { !$0.isReminder }
        let plans = shown.filter(\.isReminder)
        let peak = active ? nil : points.max { $0.value < $1.value }
        let low = active ? nil : points.filter { $0.date >= start }.min { $0.value < $1.value }
        let last = active ? points.max { $0.date < $1.date } : nil
        Chart {
            RectangleMark(xStart: .value("od", window.lowerBound), xEnd: .value("do", window.upperBound), yStart: .value("min", 70), yEnd: .value("max", 180))
                .foregroundStyle(Color.green.opacity(0.12))
            if active, now < window.upperBound {
                // What is still to come.
                RectangleMark(xStart: .value("teraz", max(now, window.lowerBound)), xEnd: .value("do", window.upperBound), yStart: .value("dół", 40), yEnd: .value("góra", top))
                    .foregroundStyle(Color.primary.opacity(0.04))
            }
            // By position: two readings at the same moment (a duplicate upload) would share a date.
            ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                LineMark(x: .value("Czas", point.date), y: .value("Glukoza", point.value))
                    .interpolationMethod(.catmullRom)
                    .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                    .foregroundStyle(Color.primary)
            }
            ForEach(Array(shown.enumerated()), id: \.offset) { _, mark in
                RuleMark(x: .value("Wpis", mark.date))
                    .foregroundStyle(Self.color(mark.style).opacity(mark.style == .reminderDue ? 1 : 0.5))
                    .lineStyle(mark.style == .reminderPlanned || mark.style == .otherDose ? StrokeStyle(lineWidth: 1.2, dash: [3, 3]) : StrokeStyle(lineWidth: 1.5))
            }
            // Entries closer than a label's width share one column of labels, in the order given (two boluses a minute
            // apart drew one label over the other); kept inside the chart at its edges.
            ForEach(Array(Self.labelGroups(doses.map(\.date), span: span).enumerated()), id: \.offset) { _, group in
                PointMark(x: .value("Wpis", doses[group[0]].date), y: .value("Góra", top))
                    .symbolSize(0)
                    .annotation(position: .bottom, alignment: .center, spacing: 2, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        VStack(spacing: 2) {
                            ForEach(group, id: \.self) { index in
                                Self.label(doses[index])
                            }
                        }
                    }
            }
            ForEach(Array(Self.labelGroups(plans.map(\.date), span: span).enumerated()), id: \.offset) { _, group in
                PointMark(x: .value("Przypomnienie", plans[group[0]].date), y: .value("Dół", 40))
                    .symbolSize(0)
                    .annotation(position: .top, alignment: .center, spacing: 2, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        VStack(spacing: 2) {
                            ForEach(group, id: \.self) { index in
                                Self.label(plans[index])
                            }
                        }
                    }
            }
            if let last {
                PointMark(x: .value("Teraz", last.date), y: .value("Glukoza", last.value))
                    .symbolSize(50)
                    .foregroundStyle(Color.primary)
                    .annotation(position: .topTrailing, spacing: 2, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        Text("\(Int(last.value.rounded()))").font(.subheadline.weight(.bold).monospacedDigit())
                    }
            }
            if let peak {
                PointMark(x: .value("Najwyżej", peak.date), y: .value("Glukoza", peak.value))
                    .symbolSize(30)
                    .foregroundStyle(Color.primary)
                    .annotation(position: .topTrailing, spacing: 2, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        Text("\(Int(peak.value.rounded()))").font(.footnote.weight(.bold).monospacedDigit())
                    }
            }
            if let low, low.value != peak?.value {
                PointMark(x: .value("Najniżej", low.date), y: .value("Glukoza", low.value))
                    .symbolSize(30)
                    .foregroundStyle(Color.primary)
                    .annotation(position: .bottom, spacing: 3, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        Text("\(Int(low.value.rounded()))").font(.footnote.weight(.bold).monospacedDigit())
                    }
            }
        }
        .chartXScale(domain: window)
        .chartYScale(domain: 40...top)
        .chartXAxis {
            // Every hour up to 3 h, every second hour beyond: six labels do not fit the phone's width. An hour too close
            // to the right edge keeps its grid line but not its label ("0…" was cut there).
            AxisMarks(values: .stride(by: .hour, count: span > 3.5 * 3600 ? 2 : 1)) { value in
                AxisGridLine().foregroundStyle(Color.secondary.opacity(0.15))
                if let date = value.as(Date.self), window.upperBound.timeIntervalSince(date) >= span * 0.12 {
                    AxisValueLabel(format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
                }
            }
        }
        .chartYAxis {
            AxisMarks(values: [70, 180]) { _ in
                AxisValueLabel()
            }
        }
    }

    private static func reminderLabel(_ reminder: MealJournalReminder) -> String {
        switch reminder.kind {
        case .wbt: return "WBT"
        case .secondDose: return "druga dawka"
        case .plannedPart: return "druga część"
        case .unknown: return "przypomnienie"
        }
    }

    private static func color(_ style: Mark.Style) -> Color {
        switch style {
        case .dose, .otherDose: return MealJournalStyle.bolus
        case .carbs: return .orange
        case .reminderDue, .reminderPlanned: return MealJournalStyle.reminder
        }
    }

    @ViewBuilder
    private static func label(_ mark: Mark) -> some View {
        let filled = mark.style == .dose || mark.style == .carbs || mark.style == .reminderDue
        Text(mark.text)
            .font(.caption2.weight(.bold).monospacedDigit())
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(filled ? Color.white : color(mark.style))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background {
                if filled {
                    Capsule().fill(mark.style == .dose ? MealJournalStyle.bolusFill : color(mark.style))
                } else {
                    Capsule().fill(MealJournalStyle.card).overlay(Capsule().strokeBorder(color(mark.style), lineWidth: 1))
                }
            }
    }
}

extension MealOverviewChart {
    /// About a label's width as a share of the chart's time span: entries closer than this share one label column.
    static let labelGroupShare = 0.12

    /// From 30 min before the meal to 30 min past now or the last reminder to come, at least 2 h after the meal so a new
    /// meal's chart is not all zoom, at most 6 h after it.
    static func window(start: Date, pending: [Date], now: Date) -> ClosedRange<Date> {
        let from = start.addingTimeInterval(-30 * 60)
        let wanted = (pending + [now]).max()!.addingTimeInterval(30 * 60)
        let end = min(start.addingTimeInterval(6 * 3600), max(wanted, start.addingTimeInterval(2 * 3600)))
        return from...end
    }

    /// Indexes of the entries, sorted by time, grouped while each is within the label width of the group's first one.
    static func labelGroups(_ dates: [Date], span: TimeInterval) -> [[Int]] {
        let gap = max(60, span * labelGroupShare)
        var groups: [[Int]] = []
        for index in dates.indices.sorted(by: { dates[$0] < dates[$1] }) {
            if let first = groups.last?.first, dates[index].timeIntervalSince(dates[first]) < gap {
                groups[groups.count - 1].append(index)
            } else {
                groups.append([index])
            }
        }
        return groups
    }
}

/// Readings missing since a time. Everything else is said on the chart.
struct MealOverviewCGMNote: View {
    let overview: MealOverview
    var now = Date()

    var body: some View {
        if let last = overview.glucose.compactMap(\.date).max(), now.timeIntervalSince(last) > 15 * 60,
           let start = overview.item.startedDate, now < start.addingTimeInterval(6 * 3600) {
            Label("Brak odczytów CGM od \(MealJournalFormat.clock(last))", systemImage: "antenna.radiowaves.left.and.right.slash")
                .font(.caption)
                .foregroundStyle(.orange)
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
