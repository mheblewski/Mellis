import Charts
import Combine
import SwiftUI

/// What the Meals tab hands back to the app: open a conversation, the Bolus tab, or a new chat.
public struct MealJournalActions {
    public var openConversation: (String) -> Void
    public var openBolusTab: () -> Void
    /// The Bolus tab with these grams typed (a planned meal); the dose and its checks are the tab's own.
    /// With the insulin too when a smaller dose was chosen on the meal's page.
    public var openBolusTabWithCarbs: ((Int, Double?) -> Void)? = nil
    public var openNewChat: () -> Void
    /// A new chat with this text ready to send ("Nowy podział w czacie" after "Scal").
    public var openNewChatWithText: (String) -> Void

    public init(
        openConversation: @escaping (String) -> Void,
        openBolusTab: @escaping () -> Void,
        openNewChat: @escaping () -> Void,
        openNewChatWithText: ((String) -> Void)? = nil,
        openBolusTabWithCarbs: ((Int, Double?) -> Void)? = nil
    ) {
        self.openBolusTabWithCarbs = openBolusTabWithCarbs
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
    @Environment(\.loopSystem) private var loopSystem
    @Environment(\.liveUpdates) private var liveUpdates
    @Environment(\.scenePhase) private var scenePhase
    @Binding private var focus: MealRoute?
    @Binding private var requestedDay: Date?
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
    /// The row whose "Usuń" or "Scal" is uncovered.
    @State private var openSwipe: MealSwipeOpen?
    /// The meal held down: its "Scal" and "Usuń" menu is open.
    @State private var menuMealID: String?
    /// "Opisz" on a tile: the meal's chat in a sheet.
    @State private var describeRoute: MealRoute?
    private let api: APIClient
    private let patientName: String?
    /// The search capsule at the bottom of the tab.
    private let searchable: Bool
    @StateObject private var mealPlan: MealPlanModel
    /// The search field shows only after the icon next to the month (it used to lie over the list).
    @State private var isSearchOpen = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SEARCH"] != nil
    private let actions: MealJournalActions
    private let trailingControls: TrailingControls

    public init(
        patientID: String,
        api: APIClient,
        focus: Binding<MealRoute?>,
        patientName: String?,
        searchable: Bool = true,
        requestedDay: Binding<Date?> = .constant(nil),
        actions: MealJournalActions,
        @ViewBuilder trailingControls: () -> TrailingControls
    ) {
        _requestedDay = requestedDay
        self.searchable = searchable
        _viewModel = StateObject(wrappedValue: MealJournalViewModel(patientID: patientID, api: api))
        _mealPlan = StateObject(wrappedValue: MealPlanModel(patientID: patientID, api: api))
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
            .modifier(MealSearchField(isOn: searchable, hidden: viewModel.isSelecting, isOpen: $isSearchOpen, query: $viewModel.query))
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if viewModel.isSelecting { mergeBar }
            }
            // Over the search capsule, which comes into view as the bar is thrown down; the list does not move.
            .overlay(alignment: .bottom) {
                if let change = viewModel.undoableChange {
                    MealUndoBar(
                        change: change,
                        onUndo: { viewModel.undoChange() },
                        onDismiss: { viewModel.commitUndoableChange() }
                    )
                    .id(change.id)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .overlayPreferenceValue(MealRowMenuAnchor.self) { anchor in
                if let mealID = menuMealID {
                    MealRowMenuLayer(
                        anchor: anchor,
                        onClose: { closeMenu() },
                        onMerge: {
                            closeMenu()
                            withAnimation(.snappy(duration: 0.25)) { viewModel.startSelecting(with: mealID) }
                        },
                        onDelete: {
                            closeMenu()
                            viewModel.requestDelete(mealID)
                        }
                    )
                }
            }
            .onChange(of: viewModel.isSelecting) { _, _ in menuMealID = nil }
            // The finger that held a meal may go on to scroll the list: the menu is not for that place any more.
            .onChange(of: isScrolling) { _, scrolling in if scrolling, menuMealID != nil { closeMenu() } }
            .onDisappear { menuMealID = nil }
            // The title is drawn above the list (MealsTitle, with the refresh ring next to it); the bar keeps it for
            // the back button of the meal pages.
            .navigationTitle("Posiłki")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .navigationDestination(for: String.self) { mealID in
                if mealID.hasPrefix(MealRoute.planPrefix) {
                    MealPlanEntryPage(
                        entryID: String(mealID.dropFirst(MealRoute.planPrefix.count)),
                        patientID: viewModel.patientID,
                        patientName: patientName,
                        plan: mealPlan,
                        api: api,
                        actions: actions
                    )
                } else {
                MealOverviewView(
                    patientID: viewModel.patientID,
                    mealID: mealID,
                    api: api,
                    patientName: patientName,
                    actions: actions,
                    request: pageRequest?.mealID == mealID ? pageRequest : nil
                ) { handled in
                    if pageRequest?.id == handled { pageRequest = nil }
                }
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
            .task(id: liveUpdates.map(ObjectIdentifier.init)) { mealPlan.bindLiveUpdates(liveUpdates) }
            .task {
                await mealPlan.load()
                viewModel.allowsFutureDays = mealPlan.isAvailable
            }
            .onChange(of: mealPlan.isAvailable) { _, available in viewModel.allowsFutureDays = available }
            .overlay(alignment: .bottom) {
                if let removed = mealPlan.removed {
                    MealPlanUndoBar(title: removed.isMeal ? "Usunięto. Przypomnienia nie będzie." : "Usunięto z planu.", onUndo: { Task { await mealPlan.undoRemove() } }, onDismiss: { mealPlan.clearUndo() })
                        .id(removed.id)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
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
            // The first page could not be read: read again after 3, 6, 12… s (at most 30) while the tab is open, so an
            // empty list does not wait for a pull or for leaving the tab.
            .task(id: viewModel.loadState) {
                var pause = 3.0
                while viewModel.loadState == .failed {
                    try? await Task.sleep(for: .seconds(pause))
                    guard !Task.isCancelled else { return }
                    await viewModel.load()
                    pause = min(pause * 2, 30)
                }
            }
        }
        .onChange(of: requestedDay, initial: true) { _, day in
            guard let day else { return }
            requestedDay = nil
            Task { await viewModel.select(day) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await viewModel.load() } }
            if phase == .background { viewModel.commitUndoableChange() }
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
                viewModel.closeMergeQuestion()
                Task { await viewModel.confirmMergeReset() }
            }
            Button("Anuluj", role: .cancel) { viewModel.cancelMergeQuestion() }
        } message: {
            Text(MealMergeText.resetQuestion)
        }
        .alert(mergeCarbsText?.question ?? "", isPresented: mergeQuestionBinding(.chooseCarbs)) {
            if let text = mergeCarbsText {
                Button("\(text.includedTitle), \(text.includedResult)") {
                    viewModel.closeMergeQuestion()
                    Task { await viewModel.chooseMergeCarbs(.included) }
                }
                Button("\(text.extraTitle), \(text.extraResult)") {
                    viewModel.closeMergeQuestion()
                    Task { await viewModel.chooseMergeCarbs(.extra) }
                }
            }
            Button("Anuluj", role: .cancel) { viewModel.cancelMergeQuestion() }
        } message: {
            if let text = mergeCarbsText { Text(text.context) }
        }
        .alert("Rozłożony bolus", isPresented: mergeQuestionBinding(.chooseSplit)) {
            Button("Zostaw podział") {
                viewModel.closeMergeQuestion()
                Task { await viewModel.chooseMergeSplit(.keep) }
            }
            Button("Nowy podział w czacie") {
                viewModel.closeMergeQuestion()
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
        .alert("Usunąć posiłek?", isPresented: Binding(
            get: { viewModel.deleteQuestion != nil },
            set: { shown in if !shown { viewModel.cancelDelete() } }
        )) {
            Button("Usuń posiłek", role: .destructive) { viewModel.confirmDelete() }
            Button("Anuluj", role: .cancel) { viewModel.cancelDelete() }
        } message: {
            Text(viewModel.deleteQuestion?.text ?? "")
        }
        .sheet(item: $describeRoute, onDismiss: { Task { await viewModel.load() } }) { route in
            MealChatView(route: route, api: api, closesAfterAccept: true) { describeRoute = nil }
        }
        .closesForNotification(isPresented: describeRoute != nil) { describeRoute = nil }
    }

    private var mergeCarbsText: MealMergeCarbsText? {
        viewModel.mergeCarbs.map { MealMergeCarbsText($0, others: viewModel.mergeOtherMealsCount, loopLocative: loopSystem.names.locative) }
    }

    private func mergeQuestionBinding(_ question: MealJournalViewModel.MergeQuestion) -> Binding<Bool> {
        Binding(
            get: { viewModel.mergeQuestion == question },
            set: { shown in if !shown, viewModel.mergeQuestion == question { viewModel.cancelMergeQuestion() } }
        )
    }

    /// While ticking meals for "Scal": how many are ticked and the button that merges them.
    private func closeMenu() {
        withAnimation(.snappy(duration: 0.15)) { menuMealID = nil }
    }

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
                onSearch: searchable && !viewModel.isSearchActive && !viewModel.isSelecting ? { withAnimation(.snappy(duration: 0.25)) { isSearchOpen = true } } : nil,
                edgeInset: 0
            )
            if !viewModel.isSearchActive {
                Group {
                    if showsMonth {
                        MealsMonthCalendar(viewModel: viewModel, planMarker: { mealPlan.hasEntries(on: $0) })
                            .padding(8)
                    } else {
                        MealsWeekStrip(viewModel: viewModel, planMarker: { mealPlan.hasEntries(on: $0) })
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
        if !viewModel.isSearchActive, viewModel.calendar.isDateInToday(viewModel.selectedDay) {
            MealPlanPinnedCard(entries: mealPlan.entries, plates: mealPlan.plates, patientID: viewModel.patientID, api: api) { entry in
                path = [MealRoute.planPrefix + entry.id]
            }
        }
        // A day ahead has only its plan; today has the plan above what happened.
        let ahead = viewModel.isFuture(viewModel.selectedDay)
        let days = ahead ? [] : viewModel.days
        if mealPlan.isAvailable, !viewModel.isSearchActive, ahead || viewModel.calendar.isDateInToday(viewModel.selectedDay) {
            planSection(ahead: ahead)
        }
        if days.isEmpty, !ahead {
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
                            MealSwipeRow(
                                mealID: item.meal_id,
                                isEnabled: !viewModel.isSelecting && !viewModel.isMerging,
                                open: $openSwipe,
                                listScrolling: isScrolling,
                                menuMealID: menuMealID,
                                onMerge: {
                                    withAnimation(.snappy(duration: 0.25)) { viewModel.startSelecting(with: item.meal_id) }
                                },
                                onDelete: { viewModel.requestDelete(item.meal_id) }
                            ) {
                                MealJournalTile(
                                    item: item,
                                    busySwitches: Set(viewModel.togglingIDs),
                                    onOpen: { path = [item.meal_id] },
                                    onAction: { action in
                                        guard case let .setMealReminder(mealID, reminderID, enabled) = action else { return }
                                        Task { await viewModel.setReminder(mealID: mealID, reminderID: reminderID, enabled: enabled) }
                                    },
                                    onHold: viewModel.isSelecting || viewModel.isMerging || openSwipe != nil ? nil : {
                                        withAnimation(.spring(duration: 0.32, bounce: 0.22)) { menuMealID = item.meal_id }
                                    },
                                    onDescribe: viewModel.isSelecting ? nil : {
                                        describeRoute = MealRoute(patientID: viewModel.patientID, mealID: item.meal_id)
                                    },
                                    isMenuOpen: menuMealID == item.meal_id
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
                            }
                            .modifier(TracksVisibility(id: item.meal_id, day: day.day, visible: visibleMeals))
                            .id(item.meal_id)
                            // "Scal": a ticked meal shrinks away into the merged one.
                            .transition(.asymmetric(insertion: .opacity, removal: .scale(scale: 0.8).combined(with: .opacity)))
                        }
                    }
                    // The swipe panels end at the card's rounded corners.
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
            }
            .id(day.day)
        }
        if viewModel.canLoadMore {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                // While the end is in view the list keeps reading: each new page's cursor starts it again, and a failed or
                // empty read is tried again after a pause instead of leaving the list stuck on the last page.
                .task(id: viewModel.olderPageCursor) { await viewModel.keepLoadingOlder() }
        }
    }

    @ViewBuilder
    private func planSection(ahead: Bool) -> some View {
        if ahead {
            planList(ahead: true, hiding: nil)
        } else {
            // Today: the meal pinned at the top is not listed again under "Zaplanowane" (owner 2026-11-09). Same clock as the pin.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                planList(ahead: false, hiding: MealPlanPin.entry(in: mealPlan.entries, now: context.date)?.id)
            }
        }
    }

    @ViewBuilder
    private func planList(ahead: Bool, hiding pinnedID: String?) -> some View {
        // A meal a dose was given for is under "Dziś" as the eaten meal (unless the dose was for something else).
        let entries = mealPlan.entries(on: viewModel.selectedDay).filter { $0.id != pinnedID && !$0.hasDoseForIt }
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                MealJournalSectionHeader(ahead ? MealJournalFormat.dayTitle(viewModel.selectedDay, calendar: viewModel.calendar) : "Zaplanowane")
                MealJournalCard {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            if index > 0 { Divider().padding(.leading, 74) }
                            MealSwipeRow(
                                mealID: MealRoute.planPrefix + entry.id,
                                isEnabled: true,
                                open: $openSwipe,
                                listScrolling: isScrolling,
                                menuMealID: nil,
                                allowsMerge: false,
                                onMerge: {},
                                onDelete: { Task { await mealPlan.remove(entry) } }
                            ) {
                                MealPlanRow(entry: entry) {
                                    path = [MealRoute.planPrefix + entry.id]
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                            }
                        }
                    }
                }
                MealJournalSectionFooter("Przypomnę 20 minut przed każdym posiłkiem z planu.")
                if let end = MealPlanEnd.line(entries: mealPlan.entries, selectedDay: viewModel.selectedDay) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(end).font(.footnote).foregroundStyle(.secondary)
                        Button("Dodaj kolejny jadłospis") { actions.openNewChatWithText("Dodaj jadłospis: ") }
                            .font(.subheadline.weight(.semibold))
                            .frame(minHeight: 44)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 6)
                }
            }
            .padding(.top, 12)
        } else if ahead {
            VStack(alignment: .leading, spacing: 0) {
                MealJournalSectionHeader(MealJournalFormat.dayTitle(viewModel.selectedDay, calendar: viewModel.calendar))
                MealJournalCard {
                    VStack(spacing: 12) {
                        Text("Na ten dzień nie ma planu.").foregroundStyle(.secondary)
                        Button("Dodaj jadłospis lub plan lekcji") { actions.openNewChatWithText("Dodaj jadłospis: ") }
                            .buttonStyle(.bordered)
                            .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(16)
                }
            }
            .padding(.top, 12)
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
/// meal down opens its menu, the tile's own gesture beside its tap; "Scal" there starts with it ticked.)
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

/// A row with a side uncovered: "Scal" on the left (the row moved right), "Usuń" on the right.
struct MealSwipeOpen: Equatable {
    enum Side: Equatable { case merge, delete }
    let mealID: String
    let side: Side
}

/// A meal on the list: moved left it uncovers "Usuń", moved right "Scal", and moved far enough it does that at once.
/// Held down, the same two are in MealRowMenuLayer. A vertical move stays the list's. (A plain gesture and not
/// swipeActions: the list is a scroll view, see above.)
private struct MealSwipeRow<Content: View>: View {
    let mealID: String
    let isEnabled: Bool
    @Binding var open: MealSwipeOpen?
    let listScrolling: Bool
    let menuMealID: String?
    var allowsMerge = true
    let onMerge: () -> Void
    let onDelete: () -> Void
    @ViewBuilder let content: Content

    private static var panelWidth: CGFloat { 84 }
    private static var mergeIcon: String { MealRowMenuLayer.mergeIcon }
    /// The finger's position while it moves the row sideways.
    @State private var dragX: CGFloat?
    @State private var dragStart: CGFloat = 0
    @State private var width: CGFloat = 0
    /// Past the point of letting go doing the action: a tap of the phone says so.
    @State private var pastFull = false
    /// The finger has just let go of a swipe: the row or a button under it must not take that as its tap.
    @State private var swipeEnding = false

    private var restingX: CGFloat {
        guard open?.mealID == mealID, let side = open?.side else { return 0 }
        return side == .merge ? Self.panelWidth : -Self.panelWidth
    }

    private var fullDistance: CGFloat { max(160, width * 0.55) }

    var body: some View {
        let x = dragX ?? restingX
        ZStack {
            HStack(spacing: 0) {
                if x > 0 {
                    panel("Scal", icon: Self.mergeIcon, color: Brand.interactive, width: x) { act(onMerge) }
                }
                Spacer(minLength: 0)
                if x < 0 {
                    panel("Usuń", icon: "trash", color: Color(red: 0.788, green: 0.188, blue: 0.173), width: -x) { act(onDelete) }
                }
            }
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(MealJournalStyle.card)
                // While a menu is open a tap anywhere only closes it (the list still takes a drag).
                .allowsHitTesting(x == 0 && menuMealID == nil)
                // SwiftUI's tap survives a small sideways move, and a swipe begun on a button ends on it.
                .disabled(dragX != nil || swipeEnding)
                .overlay {
                    // A row left open: a tap on it closes it and does not open the meal.
                    if x != 0, dragX == nil {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { withAnimation(.snappy(duration: 0.25)) { open = nil } }
                    }
                }
                .offset(x: x)
        }
        .clipped()
        .anchorPreference(key: MealRowMenuAnchor.self, value: .bounds) { menuMealID == mealID ? $0 : nil }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background {
            MealSwipeWatcher(
                isEnabled: isEnabled && menuMealID == nil,
                onBegin: beginSwipe,
                onMove: moveSwipe,
                onEnd: endSwipe
            )
        }
        .onChange(of: listScrolling) { _, scrolling in
            if scrolling, dragX == nil, open?.mealID == mealID { withAnimation(.snappy(duration: 0.25)) { open = nil } }
        }
        .onChange(of: isEnabled) { _, enabled in
            if !enabled, open?.mealID == mealID { open = nil }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: pastFull)
        .accessibilityAction(named: "Usuń", onDelete)
    }

    private func act(_ action: () -> Void) {
        withAnimation(.snappy(duration: 0.25)) { open = nil }
        action()
    }

    private func panel(_ title: String, icon: String, color: Color, width: CGFloat, action: @escaping () -> Void) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon).font(.title3)
            Text(title).font(.footnote.weight(.semibold))
        }
        .foregroundStyle(.white)
        .frame(width: max(Self.panelWidth, width))
        .frame(maxHeight: .infinity)
        .frame(width: width)
        .clipped()
        .background { Rectangle().fill(color) }
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .accessibilityHidden(true)
    }

    private func beginSwipe(_ translation: CGFloat) {
        dragStart = translation - restingX
        if open?.mealID != mealID { open = nil }
        moveSwipe(translation)
    }

    private func moveSwipe(_ translation: CGFloat) {
        let x = translation - dragStart
        // A planned row has only "Usuń".
        dragX = allowsMerge ? x : min(x, 0)
        pastFull = abs(x) > fullDistance
    }

    private func endSwipe(_ translation: CGFloat, velocity: CGFloat) {
        guard let x = dragX else { return }
        swipeEnding = true
        Task {
            try? await Task.sleep(for: .milliseconds(200))
            swipeEnding = false
        }
        let flung = translation + velocity * 0.2 - dragStart
        pastFull = false
        withAnimation(.snappy(duration: 0.25)) {
            dragX = nil
            if abs(x) > fullDistance {
                open = nil
            } else if abs(x) > 40 || abs(flung) > 120, (x < 0) == (flung < 0) {
                open = MealSwipeOpen(mealID: mealID, side: x > 0 ? .merge : .delete)
            } else {
                open = nil
            }
        }
        if x > fullDistance { onMerge() }
        if x < -fullDistance { onDelete() }
    }
}

/// The held row's frame, for the menu drawn over the whole list.
private struct MealRowMenuAnchor: PreferenceKey {
    static var defaultValue: Anchor<CGRect>? { nil }
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = value ?? nextValue()
    }
}

/// The menu of a held meal: everything but that meal dims and the menu floats beside it. Our own and not contextMenu: iOS
/// keeps the touches for itself while its menu closes, and the list did not scroll for that moment. Here a touch outside
/// closes the menu and goes on to the list.
private struct MealRowMenuLayer: View {
    static var mergeIcon: String { "arrow.down.and.line.horizontal.and.arrow.up" }
    private static var width: CGFloat { 232 }
    private static var itemHeight: CGFloat { 46 }
    private static var inset: CGFloat { 6 }
    private static var height: CGFloat { itemHeight * 2 + inset * 2 }
    private static var gap: CGFloat { 10 }
    /// The tab bar floats over the bottom of the list.
    private static var bottomClearance: CGFloat { 84 }
    private static var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 26, style: .continuous) }
    private static var spotlight: RoundedRectangle { RoundedRectangle(cornerRadius: 20, style: .continuous) }

    @Environment(\.colorScheme) private var colorScheme
    let anchor: Anchor<CGRect>?
    let onClose: () -> Void
    let onMerge: () -> Void
    let onDelete: () -> Void

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                MealMenuTouchWatcher(onTouch: onClose)
                    .ignoresSafeArea()
                if let anchor {
                    let row = proxy[anchor]
                    dim(around: row, in: proxy.size)
                        .allowsHitTesting(false)
                    menu
                        .frame(width: Self.width, height: Self.height)
                        .offset(x: max(16, row.maxX - Self.width - 12), y: menuY(row: row, height: proxy.size.height))
                        .transition(.scale(scale: 0.8, anchor: opensUp(row: row, height: proxy.size.height) ? .bottomTrailing : .topTrailing).combined(with: .opacity))
                }
            }
        }
    }

    /// Under the meal; above it when there is no room below; over its lower part when it is taller than both.
    private func menuY(row: CGRect, height: CGFloat) -> CGFloat {
        let limit = height - Self.bottomClearance - Self.height
        if row.maxY + Self.gap <= limit { return row.maxY + Self.gap }
        if opensUp(row: row, height: height) { return row.minY - Self.gap - Self.height }
        return max(8, limit)
    }

    private func opensUp(row: CGRect, height: CGFloat) -> Bool {
        row.maxY + Self.gap > height - Self.bottomClearance - Self.height && row.minY - Self.gap - Self.height >= 8
    }

    private func dim(around row: CGRect, in size: CGSize) -> some View {
        Path { path in
            path.addRect(CGRect(origin: .zero, size: size).insetBy(dx: -40, dy: -200))
            path.addPath(Self.spotlight.path(in: row))
        }
        .fill(Color.black.opacity(colorScheme == .dark ? 0.62 : 0.32), style: FillStyle(eoFill: true))
        .overlay(alignment: .topLeading) {
            Self.spotlight
                .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.14 : 0), lineWidth: 1)
                .frame(width: row.width, height: row.height)
                .offset(x: row.minX, y: row.minY)
        }
        .transition(.opacity)
    }

    private var menu: some View {
        VStack(spacing: 0) {
            item("Scal z innymi", icon: Self.mergeIcon, color: .primary, action: onMerge)
            item("Usuń", icon: "trash", color: MealJournalStyle.destructiveText, action: onDelete)
        }
        .padding(Self.inset)
        .glassBubble(in: Self.shape)
    }

    private func item(_ title: String, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.body.weight(.medium))
                    .frame(width: 24)
                Text(title)
                    .font(.body.weight(.medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .frame(height: Self.itemHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(MealMenuItemStyle())
    }
}

private struct MealMenuItemStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.primary.opacity(configuration.isPressed ? 0.12 : 0))
            }
    }
}

/// Reports a touch and lets it through: the list under it scrolls with the same finger.
#if os(iOS)
private struct MealMenuTouchWatcher: UIViewRepresentable {
    let onTouch: () -> Void

    final class Watcher: UIView {
        var onTouch: (() -> Void)?
        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
            // After this touch has found its view: the rows take no tap until the menu is closed.
            if event?.type == .touches, let onTouch { DispatchQueue.main.async(execute: onTouch) }
            return nil
        }
    }

    func makeUIView(context: Context) -> Watcher { Watcher() }
    func updateUIView(_ view: Watcher, context: Context) { view.onTouch = onTouch }
}
#else
private struct MealMenuTouchWatcher: View {
    let onTouch: () -> Void
    var body: some View { Color.clear.contentShape(Rectangle()).onTapGesture(perform: onTouch) }
}
#endif

/// Moves a meal sideways, beside the list's own gestures. It begins only for a clearly sideways move, so a vertical one is
/// the list's alone, and it ends the list's pan for that one touch, so only the row moves. (Not SwiftUI's DragGesture: on a
/// phone a slight sideways move left the list not scrolling.)
#if os(iOS)
private struct MealSwipeWatcher: UIViewRepresentable {
    let isEnabled: Bool
    let onBegin: (CGFloat) -> Void
    let onMove: (CGFloat) -> Void
    let onEnd: (CGFloat, CGFloat) -> Void

    final class Watcher: UIView, UIGestureRecognizerDelegate {
        private static let sidewaysRatio: CGFloat = 1.5

        var isEnabled = true
        var onBegin: ((CGFloat) -> Void)?
        var onMove: ((CGFloat) -> Void)?
        var onEnd: ((CGFloat, CGFloat) -> Void)?
        private lazy var recognizer: UIPanGestureRecognizer = {
            let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handle))
            recognizer.maximumNumberOfTouches = 1
            recognizer.delegate = self
            return recognizer
        }()
        private weak var scrollView: UIScrollView?
        private var isSwiping = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            recognizer.view?.removeGestureRecognizer(recognizer)
            guard window != nil else {
                if isSwiping { finish(translation: 0, velocity: 0) }
                return
            }
            scrollView = enclosingScrollView(of: self)
            scrollView?.addGestureRecognizer(recognizer)
        }

        @objc private func handle(_ recognizer: UIPanGestureRecognizer) {
            let translation = recognizer.translation(in: self).x
            switch recognizer.state {
            case .began:
                isSwiping = true
                if let pan = scrollView?.panGestureRecognizer {
                    pan.isEnabled = false
                    pan.isEnabled = true
                }
                onBegin?(translation)
            case .changed:
                onMove?(translation)
            default:
                finish(translation: translation, velocity: recognizer.velocity(in: self).x)
            }
        }

        private func finish(translation: CGFloat, velocity: CGFloat) {
            isSwiping = false
            onEnd?(translation, velocity)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard isEnabled, let scrollView, !scrollView.isDecelerating else { return false }
            return bounds.contains(touch.location(in: self))
        }

        override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard gestureRecognizer === recognizer else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
            guard let scrollView, !scrollView.isDragging else { return false }
            let velocity = recognizer.velocity(in: self)
            return abs(velocity.x) > abs(velocity.y) * Self.sidewaysRatio
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }

    func makeUIView(context: Context) -> Watcher {
        let view = Watcher()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: Watcher, context: Context) {
        view.isEnabled = isEnabled
        view.onBegin = onBegin
        view.onMove = onMove
        view.onEnd = onEnd
    }
}

private func enclosingScrollView(of view: UIView) -> UIScrollView? {
    var ancestor = view.superview
    while let current = ancestor, !(current is UIScrollView) { ancestor = current.superview }
    return ancestor as? UIScrollView
}
#else
private struct MealSwipeWatcher: View {
    let isEnabled: Bool
    let onBegin: (CGFloat) -> Void
    let onMove: (CGFloat) -> Void
    let onEnd: (CGFloat, CGFloat) -> Void
    var body: some View { Color.clear }
}
#endif

/// Tells of a finger resting on a meal, beside the list's own gestures: UIKit's long press runs together with the scroll
/// view's pan and takes no touch from it, so a finger that rests and then moves still scrolls. Nothing shows for the first
/// moment, so a light touch or the start of a scroll leaves the row as it is.
#if os(iOS)
private struct MealHoldWatcher: UIViewRepresentable {
    let isEnabled: Bool
    let onPress: (Bool) -> Void
    let onHold: () -> Void

    final class Watcher: UIView, UIGestureRecognizerDelegate {
        private static let pressAfter: TimeInterval = 0.18
        private static let holdAfter: TimeInterval = 0.45
        private static let allowedMove: CGFloat = 10

        var isEnabled = true
        var onPress: ((Bool) -> Void)?
        var onHold: (() -> Void)?
        private lazy var recognizer: UILongPressGestureRecognizer = {
            let recognizer = UILongPressGestureRecognizer(target: self, action: #selector(handle))
            recognizer.minimumPressDuration = Self.pressAfter
            recognizer.allowableMovement = Self.allowedMove
            recognizer.cancelsTouchesInView = false
            recognizer.delaysTouchesEnded = false
            recognizer.delegate = self
            return recognizer
        }()
        private weak var scrollView: UIScrollView?
        private var start: CGPoint = .zero
        private var pendingHold: DispatchWorkItem?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            recognizer.view?.removeGestureRecognizer(recognizer)
            guard window != nil else { return endPress() }
            scrollView = enclosingScrollView(of: self)
            scrollView?.addGestureRecognizer(recognizer)
        }

        @objc private func handle(_ recognizer: UILongPressGestureRecognizer) {
            switch recognizer.state {
            case .began:
                start = recognizer.location(in: window)
                onPress?(true)
                let hold = DispatchWorkItem { [weak self] in
                    self?.pendingHold = nil
                    self?.onPress?(false)
                    self?.onHold?()
                }
                pendingHold = hold
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdAfter - Self.pressAfter, execute: hold)
            case .changed:
                let now = recognizer.location(in: window)
                if hypot(now.x - start.x, now.y - start.y) > Self.allowedMove { endPress() }
            default:
                endPress()
            }
        }

        private func endPress() {
            guard let hold = pendingHold else { return }
            hold.cancel()
            pendingHold = nil
            onPress?(false)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard isEnabled, let scrollView, !scrollView.isDragging, !scrollView.isDecelerating else { return false }
            return bounds.contains(touch.location(in: self))
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }

    func makeUIView(context: Context) -> Watcher {
        let view = Watcher()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: Watcher, context: Context) {
        view.isEnabled = isEnabled
        view.onPress = onPress
        view.onHold = onHold
    }
}
#else
private struct MealHoldWatcher: View {
    let isEnabled: Bool
    let onPress: (Bool) -> Void
    let onHold: () -> Void
    var body: some View { Color.clear }
}
#endif

private extension View {
    /// A surface over the list: lighter than its cards in dark mode, with an edge and a shadow that still show there.
    func raisedSurface(in shape: some InsettableShape) -> some View {
        modifier(RaisedSurface(shape: shape))
    }
}

private struct RaisedSurface<S: InsettableShape>: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let shape: S

    func body(content: Content) -> some View {
        content
            .background(MealJournalStyle.raised)
            .clipShape(shape)
            .overlay { shape.strokeBorder(MealJournalStyle.raisedEdge, lineWidth: 1).allowsHitTesting(false) }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.6 : 0.18), radius: colorScheme == .dark ? 16 : 11, y: 4)
    }
}

/// "Cofnij" after a delete or a merge, in the search capsule's place: the line runs out with its time, and throwing the
/// bar down ends it at once (the change stands).
private struct MealUndoBar: View {
    @Environment(\.loopSystem) private var loopSystem
    let change: MealJournalViewModel.UndoableChange
    let onUndo: () -> Void
    let onDismiss: () -> Void
    @State private var dragY: CGFloat = 0
    @State private var remaining: CGFloat = 1

    private static let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(change.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let note = change.isDelete ? MealJournalViewModel.deleteNote(loop: loopSystem.names) : change.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(MealJournalStyle.raisedSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onUndo) {
                Text("Cofnij")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(MealJournalStyle.undoButtonText)
                    .frame(minWidth: 64)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(MealJournalStyle.undoAccent, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .top) {
            Capsule().fill(MealJournalStyle.raisedSecondary.opacity(0.6)).frame(width: 36, height: 4).padding(.top, 5).accessibilityHidden(true)
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(MealJournalStyle.undoAccent)
                .frame(height: 3)
                .scaleEffect(x: remaining, anchor: .leading)
                .accessibilityHidden(true)
        }
        .raisedSurface(in: Self.shape)
        .contentShape(Self.shape)
        .offset(y: dragY)
        .opacity(max(0.35, 1 - dragY / 90))
        .gesture(
            DragGesture(minimumDistance: 4)
                .onChanged { dragY = max(0, $0.translation.height) }
                .onEnded { value in
                    if dragY > 36 || value.predictedEndTranslation.height > 90 {
                        onDismiss()
                    } else {
                        withAnimation(.snappy(duration: 0.22)) { dragY = 0 }
                    }
                }
        )
        .task {
            withAnimation(.linear(duration: change.seconds)) { remaining = 0 }
            AccessibilityNotification.Announcement(change.title).post()
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Zamknij bez cofania", onDismiss)
    }
}

/// Whether the list is being dragged or still moving (iOS 18+; on 17 a row left open stays open until a tap).
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
    @Binding var isOpen: Bool
    @Binding var query: String
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        if isOn {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                if !hidden, isOpen || !query.isEmpty {
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

                        Button {
                            query = ""
                            focused = false
                            withAnimation(.snappy(duration: 0.25)) { isOpen = false }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.body.weight(.semibold))
                                .frame(width: 48, height: 48)
                        }
                        .buttonStyle(.plain)
                        .glassBubble(in: Circle())
                        .accessibilityLabel("Zamknij wyszukiwanie")
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onAppear { focused = true }
                    // An empty search closes when it loses focus: it must not come back with the keyboard after a meal's page.
                    .onChange(of: focused) { _, isFocused in
                        if !isFocused, query.isEmpty {
                            withAnimation(.snappy(duration: 0.25)) { isOpen = false }
                        }
                    }
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
    /// Bars and menus over the list. On the dark list the card's own colour melts into the cards under it and a shadow
    /// does not show: lighter here, with an edge (white text 11:1, the note 8:1).
    static let raised = Brand.dynamic(light: 0xFFFFFF, dark: 0x3A3A3C)
    static let raisedEdge = Brand.dynamic(light: 0xD1D1D6, dark: 0x8E8E93)
    static let raisedSecondary = Brand.dynamic(light: 0x55555A, dark: 0xE5E5EA)
    /// Light teal in dark mode: 6.6:1 against the bar, with dark text on it (the usual teal was 3.7:1 under white text).
    static let undoAccent = Brand.dynamic(light: 0x0F766E, dark: 0x5ED6C5)
    static let undoButtonText = Brand.dynamic(light: 0xFFFFFF, dark: 0x06302C)
    static let destructiveText = Brand.dynamic(light: 0xC9302C, dark: 0xFF8A80)
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
    /// Held down for half a second: the meal's menu (nil: no hold, e.g. search results).
    var onHold: (() -> Void)? = nil
    /// "Opisz" beside the title of a meal not described yet: its chat (nil: no chip, e.g. while ticking meals).
    var onDescribe: (() -> Void)? = nil
    /// Its menu is open. A hold begun on a button ends on it, and that is no press of the button (disabling them would
    /// grey them out under the menu).
    var isMenuOpen = false
    /// A finger has rested on the row for a moment: it sinks a little, so the hold is felt before the menu comes.
    @State private var pressing = false
    @State private var holds = 0

    var body: some View {
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
                        Button(action: { if !isMenuOpen { onDescribe() } }) {
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
                // The whole time line lives on the meal's page; here only a dose waiting now stays unfolded.
                if MealJournalTimeline.isDue(item) {
                    CardDoseTimeline(steps: MealJournalTimeline.steps(item: item, loopSystem: loopSystem), onAction: { if !isMenuOpen { onAction($0) } }, busySwitches: busySwitches)
                        .padding(10)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                } else if let next = MealJournalTimeline.nextLine(item) {
                    Text(next)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .scaleEffect(pressing ? 0.97 : 1)
        .animation(pressing ? .easeOut(duration: 0.3) : .spring(duration: 0.3, bounce: 0.3), value: pressing)
        .contentShape(Rectangle())
        // The finger of a hold lets go with the menu open: that is no tap on the meal.
        .onTapGesture { if !isMenuOpen { onOpen() } }
        .background {
            MealHoldWatcher(isEnabled: onHold != nil) { pressing = $0 } onHold: {
                pressing = false
                holds += 1
                onHold?()
            }
        }
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
}

/// A meal row of the Meals tab: the time in a fixed left column, the content, a chevron, so the day reads top to
/// bottom like a calendar agenda.
struct AgendaRow<Content: View>: View {
    let time: String
    /// Off for a row that opens nothing (a movement in the plan).
    var showsChevron = true
    let content: Content

    init(time: String, showsChevron: Bool = true, @ViewBuilder content: () -> Content) {
        self.time = time
        self.showsChevron = showsChevron
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
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
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
    /// The meal's chat, on the page itself: the composer at the bottom, the messages under the meal.
    @StateObject private var chat: MealChatViewModel
    @StateObject private var revealStore = TextRevealStore()
    @State private var isComposerFocused = false
    @State private var visibleHeight: CGFloat = 0
    @State private var proposalEdit: MealChatProposal?
    @State private var isProposalEditPresented = false
    /// The part a push asked for (a meal may have several due at once); nil: the part that is due first.
    @State private var requestedPartID: String?
    private let api: APIClient
    private let patientName: String?
    private let actions: MealJournalActions
    private let request: MealPageRequest?
    /// The request was carried out (or cannot be: the page did not load); the tab forgets it.
    private let onRequestHandled: (UUID) -> Void
    @State private var wbtRoute: MealRoute?
    /// The card of a planned part (the second part of a split bolus, a deferred meal bolus): it gives that part.
    @State private var plannedPartRoute: MealRoute?
    @State private var editingMeal: MealDetail?
    @State private var partOnItsWay = false
    @State private var loadingEdit = false
    /// The title in the page has scrolled away: the bar shows it instead.
    @State private var titleScrolledAway = false

    init(patientID: String, mealID: String, api: APIClient, patientName: String? = nil, actions: MealJournalActions, request: MealPageRequest? = nil, onRequestHandled: @escaping (UUID) -> Void = { _ in }) {
        _viewModel = StateObject(wrappedValue: MealOverviewViewModel(patientID: patientID, mealID: mealID, api: api))
        _chat = StateObject(wrappedValue: MealChatViewModel(route: MealRoute(patientID: patientID, mealID: mealID), api: api))
        self.api = api
        self.patientName = patientName
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
        #if os(iOS)
        // The composer takes the bottom of the screen; the page is opened from the list and returns to it.
        .toolbar(.hidden, for: .tabBar)
        #endif
        .task {
            await viewModel.load()
            carryOut(request)
        }
        .task { await chat.load() }
        .task(id: liveUpdates.map(ObjectIdentifier.init)) { chat.bindLiveUpdates(liveUpdates) }
        .onDisappear { chat.stopPolling() }
        // What the chat changed (a proposal accepted, a reply stored) shows in the card and the numbers above it.
        .onChange(of: chat.acceptedCount) { _, _ in Task { await viewModel.load() } }
        .onChange(of: chat.chat?.messages.count) { _, _ in Task { await viewModel.load() } }
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
        .sheet(isPresented: $isProposalEditPresented) {
            MealEditSheet(meal: chat.chat?.meal, proposal: proposalEdit) { edit in
                await chat.saveEdit(&edit)
            }
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
        .closesForNotification(isPresented: isProposalEditPresented) { isProposalEditPresented = false }
        .closesForNotification(isPresented: editingMeal != nil) { editingMeal = nil }
        .alert("Posiłek", isPresented: Binding(get: { viewModel.errorMessage != nil && viewModel.overview != nil }, set: { if !$0 { viewModel.clearError() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
        // A chat that could not be read just has no composer; only a failed send asks for attention.
        .alert("Posiłek", isPresented: Binding(get: { chat.errorMessage != nil && chat.chat != nil }, set: { if !$0 { chat.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(chat.errorMessage ?? "")
        }
    }

    /// What needs a decision first, then the meal: while something is to come the course comes before the food, after
    /// it the food comes first. A meal nothing is known about leads with describing it.
    private func page(_ overview: MealOverview) -> some View {
        let active = MealJournalTimeline.isOpen(overview.item)
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header(overview)
                    if let excess = overview.dose_excess {
                        Label(excess.message, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.orange)
                            .mealPageCard(tint: .orange)
                    }
                    actionArea(overview)
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
                    VStack(alignment: .leading, spacing: 0) {
                        MealChatThread(
                            viewModel: chat,
                            revealStore: revealStore,
                            visibleHeight: visibleHeight,
                            foldsEarlierMessages: true,
                            onEditProposal: { proposal in
                                proposalEdit = proposal
                                isProposalEditPresented = true
                            }
                        )
                    }
                    .padding(.horizontal, 4)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { visibleHeight = $0 }
            .background(MealJournalStyle.page)
            .refreshable {
                await viewModel.load()
                await chat.reload()
            }
            // As in the chat: a sent message moves to the top and the reply does not scroll it away.
            .onChange(of: chat.isSending) { wasSending, isSending in
                if wasSending, !isSending, chat.errorMessage == nil {
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(MealChatThread.currentTurnID, anchor: .top) }
                    Task { @MainActor in await ScrollPinCorrection.settle { proxy.scrollTo(MealChatThread.currentTurnID, anchor: .top) } }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if chat.chat != nil {
                MealChatComposer(viewModel: chat, isFocused: $isComposerFocused)
            }
        }
    }

    /// The one place that asks for a dose: a planned part as itself on both phones, anything else by the Bolus tab.
    @ViewBuilder
    private func actionArea(_ overview: MealOverview) -> some View {
        if let partID = requestedPartID ?? viewModel.duePlannedPartID {
            MealPartActionCard(
                route: MealRoute(patientID: route.patientID, mealID: route.mealID, opensPlannedBolus: true, plannedBolusID: partID),
                api: api,
                given: overview.given_since_start,
                // A sheet of this page presents its own confirmation from the same flow: one at a time.
                presentsConfirmation: wbtRoute == nil && plannedPartRoute == nil && editingMeal == nil && !isProposalEditPresented,
                onAsk: { askInChat(overview) },
                onDetails: { openPlannedPart(partID) },
                onChanged: { Task { await viewModel.load() } },
                onOnItsWay: { partOnItsWay = $0 }
            )
            .id(partID)
        } else if let due = viewModel.dueReminder {
            actionCard(due, overview: overview)
        }
    }

    private func header(_ overview: MealOverview) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let start = overview.item.startedDate {
                let day = "\(MealJournalFormat.dayTitle(Calendar.current.startOfDay(for: start))), \(MealJournalFormat.clock(start))"
                Text(patientName.map { "\($0) · \(day)" } ?? day)
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
                    Button { askInChat(overview) } label: { Text("Zapytaj o dawkę").frame(maxWidth: .infinity) }
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
                        Text("Zapytaj o dawkę").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
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
                Button { isComposerFocused = true } label: {
                    Text("Opisz poniżej").fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
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
            // Owner 2026-11-10: these are what went to the loop, not the meal's values (those are in its macro card).
            Text("Wpisane do \(loopSystem.names.genitive)")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
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
            if let axis = overview.doseAxisLine {
                Text(axis)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(MealPageProgress.rows(overview, loopSystem: loopSystem)) { row in
                MealPageRowView(
                    row: row,
                    noteOverride: row.plannedPartID != nil && partOnItsWay ? "Wysłano, czekam na odpowiedź" : nil,
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
            Button { Task { await openEditor() } } label: {
                Text("Edytuj ręcznie").frame(maxWidth: .infinity)
            }
            .disabled(loadingEdit)
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
            // The push's part shows in the card at the top; a part the page cannot show opens as before.
            if let partID = request.plannedBolusID ?? viewModel.duePlannedPartID {
                requestedPartID = partID
            } else {
                openPlannedPart(nil)
            }
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

/// A planned part on the meal's page: the dose and one button to the confirmation, what is happening to a sent command,
/// or its outcome. Sends exactly as the part's own screen does (`PlannedBolusViewModel`, the same flow and checks).
/// While the next part is read (a push opens the meal on it): what is being worked out, never a bare spinner. After 8 s
/// one more line says it takes longer than usual (owner 2026-11-10: the card came up very late, with nothing said).
struct MealPartLoading: View {
    @State private var slow = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProgressView().padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text("Mellis liczy kolejną dawkę do tego posiłku.")
                    .font(.headline)
                Text("Sprawdza glukozę, insulinę w organizmie i to, co już podano.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if slow {
                    Text("Trwa to dłużej niż zwykle. Sprawdź połączenie z internetem.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .task {
            try? await Task.sleep(for: .seconds(8))
            withAnimation(.easeInOut(duration: 0.25)) { slow = true }
        }
    }
}

private struct MealPartActionCard: View {
    @Environment(\.loopSystem) private var loopSystem
    @Environment(\.remoteBolusHost) private var remoteBolusHost
    @Environment(\.liveUpdates) private var liveUpdates
    @StateObject private var model: PlannedBolusViewModel
    let given: MealOverview.GivenSince?
    let presentsConfirmation: Bool
    let onAsk: () -> Void
    let onDetails: () -> Void
    let onChanged: () -> Void
    let onOnItsWay: (Bool) -> Void
    @State private var confirmsSkip = false
    @State private var loadFinished = false

    init(route: MealRoute, api: PlannedBolusAPI, given: MealOverview.GivenSince?, presentsConfirmation: Bool, onAsk: @escaping () -> Void, onDetails: @escaping () -> Void, onChanged: @escaping () -> Void, onOnItsWay: @escaping (Bool) -> Void) {
        _model = StateObject(wrappedValue: PlannedBolusViewModel(route: route, api: api))
        self.given = given
        self.presentsConfirmation = presentsConfirmation
        self.onAsk = onAsk
        self.onDetails = onDetails
        self.onChanged = onChanged
        self.onOnItsWay = onOnItsWay
    }

    private var isOnItsWay: Bool {
        guard let plan = model.plan, case .waiting = MealPartAction.of(plan) else { return false }
        return true
    }

    var body: some View {
        Group {
            if let remoteBolusHost, presentsConfirmation {
                remoteBolusHost.attach(AnyView(content))
            } else {
                content
            }
        }
        .task {
            await model.load()
            loadFinished = true
        }
        .onReceive(liveUpdates?.changes.filter { $0.concerns(anyOf: ["remote_command", "meal", "meals"]) }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
            Task { await model.refresh() }
        }
        .onChange(of: model.plan?.status) { _, _ in onChanged() }
        .onChange(of: isOnItsWay, initial: true) { _, onWay in onOnItsWay(onWay) }
        .alert("Posiłek", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        if let plan = model.plan {
            switch MealPartAction.of(plan) {
            case let .give(dose):
                giveCard(plan, dose: dose)
            case let .waiting(insulin, sentByMe):
                let units = insulin.map { "\(RemoteCommandFormat.units($0)) j" }
                status(
                    title: sentByMe == false || sentByMe == nil
                        ? "Drugi opiekun wysłał \(units ?? "tę dawkę")"
                        : "Wysłano \(units ?? "tę dawkę")",
                    line: "Czekam na odpowiedź: \(loopSystem.names.nominative). Zwykle trwa to do minuty, najdłużej 3:30.",
                    systemImage: "paperplane.fill",
                    tint: MealJournalStyle.reminder,
                    showsDetails: false
                )
            case .noReply:
                status(
                    title: "Nie wiem, czy bolus podano",
                    line: "\(loopSystem.names.capitalized) nie odpowiada od 3:30. Sprawdź to w aplikacji pętli, zanim podasz dawkę ponownie.",
                    systemImage: "questionmark.circle.fill",
                    tint: .orange
                )
            case let .uncertain(insulin):
                status(
                    title: "Nie wiadomo, czy bolus \(RemoteCommandFormat.units(insulin)) j został podany",
                    line: "Pompa odpowiedziała niewyraźnie. Sprawdź historię bolusów w pompie, zanim podasz dawkę ponownie.",
                    systemImage: "questionmark.circle.fill",
                    tint: .orange
                )
            case let .carbsOnly(carbs):
                status(title: "Węgle zapisane, bolus nie", line: "\(carbs) g jest już w pętli, a insulina nie została podana.", systemImage: "exclamationmark.triangle.fill", tint: .red, retry: plan.retryBase(), retryTitle: "Podaj sam bolus")
            case .refused:
                status(title: "Bolus nie został podany", line: plan.command?.status_message ?? "Pętla odrzuciła to polecenie.", systemImage: "xmark.circle.fill", tint: .orange, retry: plan.retryBase(), retryTitle: "Podaj ponownie")
            case let .given(insulin, by, at):
                let units = insulin.map { "\(RemoteCommandFormat.units($0)) j" } ?? "dawkę"
                let time = at.flatMap(ServerDate.parse).map { " o \(LoopFormat.clock($0))" } ?? ""
                status(title: by.map { "Opiekun \($0) podał \(units)\(time)" } ?? "Podano \(units)\(time)", line: "Tej dawki nie trzeba już podawać.", systemImage: "checkmark.circle.fill", tint: .green, showsDetails: false)
            case .closed:
                EmptyView()
            }
        } else if !loadFinished {
            // Never empty before the read: a view with nothing in it would not start it.
            MealPartLoading().mealPageCard()
        } else {
            // A dose that is due never disappears because a read failed.
            status(title: "Czas na kolejną dawkę", line: "Nie udało się teraz wczytać tej dawki. Sprawdź połączenie albo otwórz szczegóły.", systemImage: "clock.fill", tint: MealJournalStyle.reminder)
        }
    }

    private func giveCard(_ plan: PlannedBolusDetail, dose: Double) -> some View {
        let warned = given?.anyGiven == true || plan.mealChangeNotice != nil
        let tint: Color = warned ? .orange : MealJournalStyle.reminder
        return VStack(alignment: .leading, spacing: 12) {
            Text(plan.isDeferred ? "Czas na bolus na posiłek" : "Czas na drugą część bolusa")
                .font(.title3.weight(.bold))
            if let line = given?.cardLine, !line.isEmpty {
                if warned {
                    Label(line, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.orange)
                } else {
                    Text(line).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if let notice = plan.mealChangeNotice {
                Label(notice.message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.orange)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Proponowana dawka").font(.footnote).foregroundStyle(.secondary)
                Text("\(RemoteCommandFormat.units(dose)) j")
                    .font(.system(size: 40, weight: .bold).monospacedDigit())
            }
            .accessibilityElement(children: .combine)
            Text(PlannedBolusView.reason(plan))
                .font(.footnote)
                .foregroundStyle(.secondary)
            VStack(spacing: 4) {
                Button { give() } label: {
                    Text("Podaj \(RemoteCommandFormat.units(dose)) j").fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(warned ? .orange : nil)
                .disabled(model.isSkipping)
                HStack(spacing: 8) {
                    Button { confirmsSkip = true } label: {
                        Text(plan.isDeferred ? "Pomiń bolus" : "Pomiń tę część").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .disabled(model.isSkipping)
                    .confirmationDialog(CardDoseTimeline.skipTitle, isPresented: $confirmsSkip, titleVisibility: .visible) {
                        Button("Wyłącz \(RemoteCommandFormat.units(plan.doseNow)) j", role: .destructive) {
                            Task {
                                await model.skip()
                                onChanged()
                            }
                        }
                        Button("Anuluj", role: .cancel) {}
                    } message: {
                        Text(CardDoseTimeline.skipMessage)
                    }
                    Button(action: onAsk) {
                        Text("Zapytaj o dawkę").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
                .buttonStyle(.borderless)
                .tint(.primary)
            }
        }
        .mealPageCard(tint: tint)
    }

    private func status(title: String, line: String, systemImage: String, tint: Color, retry: RemoteBolusDraftBase? = nil, retryTitle: String = "", showsDetails: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline)
                    Text(line).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if !progressSteps.isEmpty {
                BolusProgressBar(steps: progressSteps)
            }
            if let retry, let remoteBolusHost {
                Button { remoteBolusHost.give(retry) } label: {
                    Text(retryTitle).fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            // A sent or given dose repeats the page there; a dose in doubt keeps its fuller screen.
            if showsDetails {
                Button("Szczegóły", action: onDetails)
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
            }
        }
        .mealPageCard(tint: tint)
    }

    /// The dose's way to the loop, as on the chat's card. Before the command is read back only "Wysłano" is under way.
    private var progressSteps: [BolusProgressStep] {
        guard let plan = model.plan else { return [] }
        if let command = plan.command {
            return command.progressSteps(loop: loopSystem.names)
        }
        return plan.sending
            ? [BolusProgressStep(title: "Wysłano", state: .active), BolusProgressStep(title: "Podano", state: .waiting)]
            : []
    }

    /// The dose is re-read first when its estimate is over 2 min old; without remote control the part's screen says
    /// how to give it in the loop.
    private func give() {
        guard let remoteBolusHost else {
            onDetails()
            return
        }
        Task {
            if let base = await model.giveBase() { remoteBolusHost.give(base) }
        }
    }
}

/// A meal or a movement of the plan in the day's list.
private struct MealPlanRow: View {
    let entry: MealPlanEntry
    let onOpen: () -> Void

    var body: some View {
        AgendaRow(time: entry.plannedDate.map { MealJournalFormat.clock($0) } ?? "", showsChevron: true) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(.body.weight(entry.isMeal ? .semibold : .medium))
                    .foregroundStyle(entry.isMeal && !entry.isSkipped ? .primary : .secondary)
                    .lineLimit(1)
                Text(entry.rowSubtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .accessibilityAddTraits(.isButton)
    }
}

/// Today's next meal, from an hour before it: above the list, one tap from its page. The dose shows only in the last 30
/// minutes (MealPlanMoment.soon) and from a fresh reading; earlier it would be a guess.
private struct MealPlanPinnedCard: View {
    let entries: [MealPlanEntry]
    let plates: [String: MealPlanPlate]
    let patientID: String
    let api: APIClient
    let onOpen: (MealPlanEntry) -> Void
    @State private var dose: Double?
    @State private var cardLine: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let entry = MealPlanPin.entry(in: entries, now: context.date) {
                let moment = MealPlanMoment.of(entry, now: context.date)
                let time = entry.plannedDate.map { MealJournalFormat.clock($0) } ?? ""
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(entry.title) o \(time), \(MealPlanPin.timeLeft(to: entry, now: context.date))")
                            .font(.headline)
                        Text(line(entry, moment: moment))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button { onOpen(entry) } label: {
                        Text("Otwórz").fontWeight(.semibold).foregroundStyle(.white)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel("Otwórz: \(entry.title)")
                }
                .padding(14)
                .background(MealJournalStyle.reminder.opacity(0.18), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .padding(.top, 12)
                .transition(.opacity.combined(with: .move(edge: .top)))
                .task(id: "\(entry.id)-\(moment == .soon)-\(Int(context.date.timeIntervalSince1970 / 300))-\(plate(entry).carbs(of: entry) ?? -1)-\(plate(entry).smallerBeforeMovement)") { await readDose(entry, moment: moment) }
            }
        }
    }

    private func line(_ entry: MealPlanEntry, moment: MealPlanMoment) -> String {
        if case let .asks(given) = MealPlanDoseState.of(entry) {
            return "Bolus \(MealJournalFormat.number(given.insulin_u)) j podano. Czy do tego posiłku?"
        }
        if let cardLine, moment == .soon { return cardLine }
        if let dose, moment == .soon { return "Proponowana dawka: \(MealJournalFormat.number(dose)) j" }
        return entry.rowSubtitle
    }

    /// The meal page's card in one line, so the banner never says another dose than the page.
    static func cardLine(_ card: ConversationBolusProposal) -> String? { MealPlanEntryPageCard.line(card) }

    private func plate(_ entry: MealPlanEntry) -> MealPlanPlate { plates[entry.id] ?? MealPlanPlate() }

    private func readDose(_ entry: MealPlanEntry, moment: MealPlanMoment) async {
        guard moment == .soon, let carbs = plate(entry).carbs(of: entry), carbs > 0 else {
            dose = nil
            cardLine = nil
            return
        }
        // The same card the meal's page shows (card A); the preview's dose only where it cannot be made.
        if let items = plate(entry).eatenItems(entry), !items.isEmpty,
           let card = try? await api.mealPlanBolusCard(patientID: patientID, entryID: entry.id, items: items).proposal {
            guard !Task.isCancelled else { return }
            cardLine = MealPlanEntryPageCard.line(card)
            if cardLine != nil { return }
        }
        cardLine = nil
        let minutes = entry.plannedDate.map { max(0, min(60, Int($0.timeIntervalSinceNow / 60))) }
        let preview = try? await api.previewRemoteCommand(patientID: patientID, carbsG: carbs, insulinU: nil, bolusStep: Decimal(string: "0.05") ?? 0, mealInMinutes: minutes, proposalID: nil)
        guard !Task.isCancelled else { return }
        let fresh = preview?.context.glucose.flatMap { ServerDate.parse($0.observed_at) }.map { Date().timeIntervalSince($0) < 10.5 * 60 } ?? false
        let full = fresh ? preview.flatMap(RemoteBolusViewModel.defaultDose) : nil
        // The dose chosen on the meal's page, not another number on the card above it.
        let smaller = plate(entry).smallerBeforeMovement && MealPlanMovementAhead.of(entry, in: entries) != nil
        dose = full.map { smaller ? MealPlanMovementAhead.reduced($0) : $0 }
    }
}

/// The banner's line for a planned meal's card A.
enum MealPlanEntryPageCard {
    static func line(_ card: ConversationBolusProposal) -> String? {
        guard card.state == "PROPOSED" else { return nil }
        let number = { (value: Double) in MealJournalFormat.number(value) }
        let later = card.laterParts().map(\.insulinU).reduce(0, +)
        if let fast = card.fast_carbs_first, let grams = fast.carbs_g, grams > 0 {
            return "Najpierw \(Int(grams.rounded())) g szybkich węgli, insulina później"
        }
        if card.insulin_u == 0, later > 0 { return "Teraz bez insuliny, \(number(later)) j później" }
        if later > 0 { return "Dawka: \(number(card.insulin_u)) j teraz, \(number(later)) j później" }
        return "Proponowana dawka: \(number(card.insulin_u)) j"
    }
}

private struct MealPlanUndoBar: View {
    let title: String
    let onUndo: () -> Void
    let onDismiss: () -> Void
    @State private var dismissTask: Task<Void, Never>?

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onUndo) {
                Text("Cofnij").font(.body.weight(.semibold)).frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .glassBubble(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .task {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled else { return }
            onDismiss()
        }
    }
}

/// A planned meal's page (meal-plan.v1): the foods with switches, and near the meal a dose computed then and there. The
/// dose is given on the Bolus tab, with its checks; nothing is sent from here.
private struct MealPlanEntryPage: View {
    let entryID: String
    let patientID: String
    let patientName: String?
    @ObservedObject var plan: MealPlanModel
    let api: APIClient
    let actions: MealJournalActions
    @State private var preview: RemoteCommandPreview?
    @State private var previewFailed = false
    /// The chat's bolus card A for this meal: the plan, its later part and variants; nil where remote commands
    /// are off, on an older server, or while it loads (the dose from the preview then, as before).
    @State private var bolusCard: ConversationBolusProposal?
    @State private var bolusCardProblem: String?
    @State private var variantBusy = false
    @State private var variantError: String?
    @Environment(\.remoteBolusHost) private var remoteBolusHost
    @State private var notes: [PatientNote] = []
    @State private var editsTime = false
    @State private var editedTime = Date()
    @Environment(\.loopSystem) private var loopSystem
    /// The planned meal's chat: what changed in the menu, in words; an accepted change replaces the dishes.
    @StateObject private var chat: MealChatViewModel
    @StateObject private var revealStore = TextRevealStore()
    private let bridge: MealPlanChatBridge
    @State private var isComposerFocused = false
    @State private var visibleHeight: CGFloat = 0

    init(entryID: String, patientID: String, patientName: String?, plan: MealPlanModel, api: APIClient, actions: MealJournalActions) {
        self.entryID = entryID
        self.patientID = patientID
        self.patientName = patientName
        self.plan = plan
        self.api = api
        self.actions = actions
        let bridge = MealPlanChatBridge(api: api) { [weak plan] entry in plan?.applyChatEntry(entry) }
        self.bridge = bridge
        _chat = StateObject(wrappedValue: MealChatViewModel(route: MealRoute(patientID: patientID, mealID: entryID), api: bridge))
    }

    private var entry: MealPlanEntry? { plan.entry(id: entryID) }
    private var plate: MealPlanPlate { plan.plates[entryID] ?? MealPlanPlate() }

    /// The card's "Podaj" and "Wpisz … do Trio" open the confirmation of the Meals tab's flow: it is presented from this
    /// page (without it a tap prepared the dose and nothing showed).
    var body: some View {
        if let remoteBolusHost {
            remoteBolusHost.attach(AnyView(page))
        } else {
            page
        }
    }

    private var page: some View {
        ScrollViewReader { reader in
        ScrollView {
            if let entry {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    let moment = MealPlanMoment.of(entry, now: context.date)
                    VStack(alignment: .leading, spacing: 16) {
                        header(entry)
                        card(entry, moment: moment)
                        // Portions set the dose: not while a given dose waits for its answer, or after it was this meal's.
                        if showsChat(entry) {
                            foods(entry)
                            VStack(alignment: .leading, spacing: 0) {
                                MealChatThread(viewModel: chat, revealStore: revealStore, visibleHeight: visibleHeight, foldsEarlierMessages: true, onEditProposal: nil)
                            }
                            .padding(.horizontal, 4)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                    .task(id: PreviewKey(moment: moment, carbs: plate.carbs(of: entry), items: plate.eatenItems(entry), refresh: cardRefresh(at: context.date))) { await readDose(entry, moment: moment) }
                }
            } else if plan.hasRead, plan.lastReadFailed {
                ContentUnavailableView("Posiłek", systemImage: "wifi.exclamationmark", description: Text("Nie udało się wczytać tego posiłku. Sprawdź połączenie i wróć tu za chwilę."))
                    .padding(.top, 60)
            } else if plan.hasRead {
                ContentUnavailableView("Posiłek", systemImage: "fork.knife", description: Text("Tego posiłku nie ma już w planie."))
                    .padding(.top, 60)
            } else {
                // Opened from Teraz or a push before the plan was read: the meal is not known yet, not gone.
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
            }
        }
        // The field being typed in stays above the keyboard.
        .onPreferenceChange(MealPlanFocusedField.self) { id in
            guard let id else { return }
            Task {
                try? await Task.sleep(nanoseconds: 350_000_000)
                withAnimation(.easeOut(duration: 0.2)) { reader.scrollTo(id, anchor: .center) }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { visibleHeight = $0 }
        // As on an eaten meal's page: a sent message moves to the top and the reply does not scroll it away.
        .onChange(of: chat.isSending) { wasSending, isSending in
            if wasSending, !isSending, chat.errorMessage == nil {
                withAnimation(.easeOut(duration: 0.3)) { reader.scrollTo(MealChatThread.currentTurnID, anchor: .top) }
                Task { @MainActor in await ScrollPinCorrection.settle { reader.scrollTo(MealChatThread.currentTurnID, anchor: .top) } }
            }
        }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let entry, showsChat(entry), chat.chat != nil {
                MealChatComposer(viewModel: chat, isFocused: $isComposerFocused, firstPlaceholder: "Np. zamiast kisielu batonik")
            }
        }
        .task { await chat.load() }
        .onDisappear { chat.stopPolling() }
        .task(id: plate) { if let entry { bridge.plateSummary = plate.described(entry) } }
        .onChange(of: entry?.items) { _, _ in if let entry { bridge.plateSummary = plate.described(entry) } }
        .alert("Posiłek", isPresented: Binding(get: { chat.errorMessage != nil && chat.chat != nil }, set: { if !$0 { chat.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(chat.errorMessage ?? "")
        }
        .sheet(isPresented: $editsTime) { timeSheet }
        .scrollDismissesKeyboard(.interactively)
        .background(MealJournalStyle.page)
        .navigationTitle(entry?.title ?? "Posiłek")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        #endif
        .task { if entry == nil { await plan.load() } }
        .task {
            // An older server: no suggestions, the page works the same.
            notes = (try? await api.listPatientNotes(patientID: patientID).notes) ?? []
        }
    }

    /// The dishes and the chat about them: a meal still to come whose dose is not settled.
    private func showsChat(_ entry: MealPlanEntry) -> Bool {
        entry.isMeal && !entry.isSkipped && showsFoods(entry)
    }

    private func showsFoods(_ entry: MealPlanEntry) -> Bool {
        switch MealPlanDoseState.of(entry) {
        case .none, .forSomethingElse: return true
        case .asks, .forThisMeal: return false
        }
    }

    private struct PreviewKey: Equatable {
        let moment: MealPlanMoment
        let carbs: Int?
        let items: [MealPlanItem]?
        let refresh: Int
    }

    /// A card waiting for the fast carbs or for glucose to stop falling is computed again every 2 minutes (the carbs given
    /// or the drop stopped change the plan); an expired one too. Any other card stays until something on the page changes.
    private func cardRefresh(at date: Date) -> Int {
        guard let card = bolusCard, card.state != "SENT" else { return 0 }
        let waits = card.fast_carbs_first != nil || card.state == "EXPIRED" || card.expiresAt.map { $0 <= date } == true
        return waits ? Int(date.timeIntervalSince1970 / 120) : 0
    }

    private func header(_ entry: MealPlanEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let planned = entry.plannedDate {
                let day = "\(MealJournalFormat.dayTitle(Calendar.polish.startOfDay(for: planned))), \(MealJournalFormat.clock(planned))"
                Text(patientName.map { "\($0) · \(day)" } ?? day)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(entry.title)
                .font(.title.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            if !entry.isSkipped, let planned = entry.plannedDate, planned > Date() {
                Button("Zmień godzinę") {
                    editedTime = planned
                    editsTime = true
                }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 4)
    }

    /// For all caregivers: the reminder and the questions follow the new hour.
    private var timeSheet: some View {
        NavigationStack {
            Form {
                DatePicker("Godzina", selection: $editedTime, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    .environment(\.locale, Locale(identifier: "pl_PL"))
                Text("Dotyczy wszystkich opiekunów. Przypomnienie przyjdzie przed nową godziną.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .navigationTitle(entry?.title ?? "Godzina")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Anuluj") { editsTime = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zapisz") {
                        guard let entry else { return }
                        Task { if await plan.setTime(entry, to: editedTime) { editsTime = false } }
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    @ViewBuilder
    private func card(_ entry: MealPlanEntry, moment: MealPlanMoment) -> some View {
        switch MealPlanDoseState.of(entry) {
        case _ where !entry.isMeal:
            movementCard(entry)
        case _ where entry.isSkipped:
            momentCard(entry, moment: moment)
        case let .asks(given):
            askDose(entry, given: given)
        case let .forThisMeal(given):
            doseDone(entry, given: given)
        case .none, .forSomethingElse:
            momentCard(entry, moment: moment)
        }
    }

    /// An activity has no dose: what it may need is carbs, and the chat's rescue card works them out.
    @ViewBuilder
    private func movementCard(_ entry: MealPlanEntry) -> some View {
        let clock = entry.plannedDate.map { MealJournalFormat.clock($0) } ?? ""
        if entry.isSkipped {
            VStack(alignment: .leading, spacing: 8) {
                Text("Pominięto te zajęcia").font(.title3.weight(.bold))
                Text("Dotyczy wszystkich opiekunów. Nie będzie przypomnienia ani sugestii mniejszej dawki.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Cofnij") { Task { await plan.unskip(entry) } }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
            }
            .mealPageCard()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(entry.title) o \(clock)").font(.title3.weight(.bold))
                Text("Przypomnę 30 minut wcześniej, jeśli cukier będzie poniżej 120 albo poniżej 150 i będzie spadał. Wtedy mogą być potrzebne węglowodany.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    actions.openNewChatWithText("\(entry.title) o \(clock): czy przed zajęciami podać węglowodany, i ile?")
                } label: {
                    Text("Zapytaj o węglowodany").fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Button("Pomiń te zajęcia") { Task { await plan.skip(entry) } }
                    .font(.subheadline.weight(.semibold))
                    .tint(.primary)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .mealPageCard(tint: MealJournalStyle.reminder)
        }
    }

    /// A bolus near the meal may be for something else, so a caregiver says which.
    private func askDose(_ entry: MealPlanEntry, given: MealPlanGiven) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Bolus \(MealJournalFormat.number(given.insulin_u)) j podano o \(given.date.map { MealJournalFormat.clock($0) } ?? "")")
                .font(.title3.weight(.bold))
            Text("Czy to było do tego posiłku?").font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button { Task { await plan.answerDose(entry, answer: "THIS_MEAL") } } label: {
                    Text("Tak").fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button { Task { await plan.answerDose(entry, answer: "OTHER") } } label: {
                    Text("Nie").fontWeight(.semibold).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.large)
        }
        .mealPageCard(tint: MealJournalStyle.reminder)
    }

    private func doseDone(_ entry: MealPlanEntry, given: MealPlanGiven) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Podano \(MealJournalFormat.number(given.insulin_u)) j o \(given.date.map { MealJournalFormat.clock($0) } ?? "")", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(.green)
            Text("Tej dawki nie trzeba już podawać.").font(.subheadline).foregroundStyle(.secondary)
            eaten(entry, given: given)
        }
        .mealPageCard()
    }

    /// Only stored: carbs already in the loop change only on the phone with the loop.
    @ViewBuilder
    private func eaten(_ entry: MealPlanEntry, given: MealPlanGiven) -> some View {
        switch entry.eaten_answer {
        case "YES":
            Text("Posiłek został zjedzony.").font(.subheadline).foregroundStyle(.secondary)
        case "UNKNOWN":
            Text("Sprawdź cukier za 15 minut. Przypomnę o tym.").font(.subheadline).foregroundStyle(.secondary)
            eatenButtons(entry, withUnknown: false)
        case "PART", "NO":
            let partly = entry.eaten_answer == "PART"
            VStack(alignment: .leading, spacing: 8) {
                Label(partly ? "Zjedzono tylko część posiłku, a insulina działa." : "Posiłku nie było, a insulina działa.", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
                Text("Podaj to, co uda się zjeść, i sprawdzaj cukier częściej. Węglowodany wpisane w \(loopSystem.names.locative) zmienisz tylko na telefonie z pętlą, więc poproś o to osobę przy pacjencie.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Zapytaj, ile węglowodanów podać") {
                    let ate = partly ? "zjedzono tylko część posiłku" : "posiłek nie został zjedzony"
                    actions.openNewChatWithText("\(entry.title): podano \(MealJournalFormat.number(given.insulin_u)) j, a \(ate). Ile węglowodanów podać teraz?")
                }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
            }
        default:
            if entry.eaten_asked_at != nil {
                Text("Czy posiłek został zjedzony?").font(.subheadline.weight(.semibold))
                Text("Bolus został podany, a cukier nie rośnie.").font(.footnote).foregroundStyle(.secondary)
                eatenButtons(entry, withUnknown: true)
            }
        }
    }

    private func eatenButtons(_ entry: MealPlanEntry, withUnknown: Bool) -> some View {
        let options = [("Tak", "YES"), ("Część", "PART"), ("Nie", "NO")] + (withUnknown ? [("Nie wiem", "UNKNOWN")] : [])
        return HStack(spacing: 6) {
            ForEach(options, id: \.1) { option in
                Button { Task { await plan.answerEaten(entry, answer: option.1) } } label: {
                    Text(option.0).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, minHeight: 30)
                }
                .buttonStyle(.bordered)
            }
        }
        .controlSize(.regular)
    }

    @ViewBuilder
    private func momentCard(_ entry: MealPlanEntry, moment: MealPlanMoment) -> some View {
        switch moment {
        case let .tooEarly(doseFrom):
            VStack(alignment: .leading, spacing: 8) {
                Text("Dawkę policzę najpóźniej o \(MealJournalFormat.clock(doseFrom))")
                    .font(.title3.weight(.bold))
                Text("Wtedy będzie aktualny cukier i aktywna insulina.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                skipButton(entry)
            }
            .mealPageCard()
        case .soon, .late:
            doseCard(entry, moment: moment)
        case .tooLate:
            VStack(alignment: .leading, spacing: 8) {
                Text("Na ten posiłek nie ma już propozycji dawki")
                    .font(.title3.weight(.bold))
                Text("Upłynęło za dużo czasu, żeby liczyć ją z planu. Zapytaj w Rozmowach, co teraz zrobić.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Zapytaj o dawkę") { actions.openNewChat() }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
            }
            .mealPageCard()
        case .skipped:
            VStack(alignment: .leading, spacing: 8) {
                Text("Pominięto ten posiłek")
                    .font(.title3.weight(.bold))
                Text("Dotyczy wszystkich opiekunów. Przypomnień o nim już nie będzie.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Cofnij") { Task { await plan.unskip(entry) } }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
            }
            .mealPageCard()
        }
    }

    private func doseCard(_ entry: MealPlanEntry, moment: MealPlanMoment) -> some View {
        let carbs = plate.carbs(of: entry)
        let calculated = preview.flatMap(RemoteBolusViewModel.defaultDose)
        let lowered = MealPlanLoweredDose.of(preview)
        let wholeICR = lowered != nil && plate.wholeFromICR
        let fullDose = wholeICR ? lowered?.icrDose : calculated
        let ahead = MealPlanMovementAhead.of(entry, in: plan.entries)
        let smaller = ahead != nil && plate.smallerBeforeMovement
        let dose = fullDose.map { smaller ? MealPlanMovementAhead.reduced($0) : $0 }
        return VStack(alignment: .leading, spacing: 12) {
            if case let .forSomethingElse(given) = MealPlanDoseState.of(entry) {
                Label("Bolus \(MealJournalFormat.number(given.insulin_u)) j podano o \(given.date.map { MealJournalFormat.clock($0) } ?? ""), ale nie do tego posiłku. Sprawdź, czy ta dawka nie będzie za duża.", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if moment == .late {
                Text("\(entry.title): zaplanowano na \(entry.plannedDate.map { MealJournalFormat.clock($0) } ?? ""). Bolus nie został podany.")
                    .font(.title3.weight(.bold))
            }
            if let food = plate.foodWithoutGrams(in: entry) {
                Text("Ile węglowodanów ma: \(food)?")
                    .font(.title3.weight(.bold))
                Text("Dawkę policzę, gdy wpiszesz gramy przy tej potrawie.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if carbs == nil {
                Text("Co jest na talerzu?")
                    .font(.title3.weight(.bold))
                Text("W planie nie ma tego posiłku. Dawkę policzę, gdy wpiszesz węglowodany w zakładce Bolus.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if carbs == 0 {
                Text("Bez węglowodanów nie ma dawki na posiłek")
                    .font(.title3.weight(.bold))
                Text("Tak wychodzi z porcji ustawionych poniżej. Sprawdź je, jeśli posiłek będzie jednak zjedzony.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if let card = bolusCard, let host = remoteBolusHost {
                mealPlanCard(card, entry: entry, moment: moment, host: host)
            } else if let dose, let glucose = preview?.context.glucose, isFresh(glucose.observed_at) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Proponowana dawka").font(.footnote).foregroundStyle(.secondary)
                    Text("\(MealJournalFormat.number(dose)) j")
                        .font(.system(size: 40, weight: .bold).monospacedDigit())
                }
                .accessibilityElement(children: .combine)
                Text("Cukier \(Int(glucose.value.rounded())), około \(carbs ?? 0) g węglowodanów. Porcje są szacunkiem.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                ForEach(preview?.warnings.filter { $0.severity == "DANGER" } ?? [], id: \.self) { warning in
                    Label(warning.message, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let lowered {
                    loweredDose(lowered, entry: entry, calculated: calculated, wholeICR: wholeICR)
                }
                if let ahead, let fullDose {
                    movementSuggestion(ahead, fullDose: fullDose, smaller: smaller)
                }
            } else if previewFailed || (preview != nil) {
                Text("Nie mam świeżego odczytu glukozy")
                    .font(.title3.weight(.bold))
                Text("Bez aktualnego cukru nie proponuję dawki. Około \(carbs ?? 0) g to szacunek z jadłospisu.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            if bolusCard == nil || remoteBolusHost == nil, let give = actions.openBolusTabWithCarbs, let carbs, carbs > 0, plate.foodWithoutGrams(in: entry) == nil {
                Button {
                    plan.markGiving(entry)
                    give(carbs, smaller || wholeICR || lowered?.dose == 0 ? dose : nil)
                } label: {
                    Text("Podaj insulinę").fontWeight(.semibold).foregroundStyle(.white).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            skipButton(entry, title: moment == .late ? "Posiłku nie było" : "Pomiń ten posiłek")
        }
        .mealPageCard(tint: MealJournalStyle.reminder)
    }

    /// Card A as in the chat. With fast carbs advised they come first, as the plan's first step with their own button;
    /// before the meal's time a card of carbs alone is not given (the loop would count a meal not yet eaten).
    @ViewBuilder
    private func mealPlanCard(_ card: ConversationBolusProposal, entry: MealPlanEntry, moment: MealPlanMoment, host: RemoteBolusHost) -> some View {
        let clock = entry.plannedDate.map { MealJournalFormat.clock($0) } ?? ""
        let minutesAhead = entry.plannedDate.map { Int($0.timeIntervalSinceNow / 60) } ?? 0
        let fast = card.state == "PROPOSED" ? card.fast_carbs_first : nil
        let fastGrams = fast.flatMap { $0.carbs_g.map { Int($0.rounded()) } }
        let carbsOnlyEarly = card.state == "PROPOSED" && card.insulin_u == 0 && card.carbs_g > 0 && minutesAhead > 5
        let mealWaits = carbsOnlyEarly || (fast != nil && minutesAhead > 5)
        BolusProposalCard(
            proposal: Self.withFullDoseButton(card),
            // "Posiłek trwa" (owner 2026-11-10): the meal can start before its planned time; the step's title says the time.
            onGive: card.canGiveDraft ? { host.give(card.mealPlanDraftBase) } : nil,
            onRetry: card.mealPlanRetryBase.map { base in { host.give(base) } },
            onRecalculate: { Task { await readDose(entry, moment: moment) } },
            onOpenMeal: nil,
            embedded: true,
            leadingSteps: fast.map { [Self.fastCarbsStep($0, grams: fastGrams)] } ?? [],
            // The fast carbs' own button, inside their step (the card adds "Pomiń").
            leadingAction: fastGrams.flatMap { grams in grams > 0 ? AnyView(
                Button { host.give(.rescueCarbs(grams: grams, conversationID: nil, alertID: nil, proposalID: nil)) } label: {
                    Text("Wpisz \(grams) g do \(loopSystem.names.genitive)")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Brand.rescue)
                .controlSize(.large)
            ) : nil },
            onChooseVariant: card.canGiveDraft ? { variant in Task { await chooseVariant(variant, card: card, entry: entry, host: host) } } : nil,
            variantBusy: variantBusy,
            variantError: variantError,
            onChooseRest: card.canGiveDraft ? { rest in Task { await chooseRest(rest, card: card) } } : nil,
            onChooseLaterTime: card.canGiveDraft ? { minutes in Task { await changeCard(card, kind: "LATER_TIME", rest: nil, minutes: minutes) { _ in } } } : nil,
            firstPartAt: mealWaits ? clock : nil
        )
    }

    /// "Teraz · 10 g szybkich węgli · sok, glukoza; spadek poniżej 70 za ok. 20 min"
    static func fastCarbsStep(_ fast: ConversationBolusProposal.FastCarbsFirst, grams: Int?) -> CardTimelineStep {
        let why = fast.level == "PREDICTED_LOW"
            ? fast.minutes_to_low.map { "glukoza spadnie poniżej 70 za ok. \($0) min" } ?? "glukoza zaraz spadnie poniżej 70"
            : fast.glucose_mgdl.map { "glukoza \(Int($0.rounded()))" }
        return CardTimelineStep(
            id: "fast-carbs", time: "Teraz", detail: grams.map { "\($0) g szybkich węgli" } ?? "Szybkie węgle",
            note: ["sok, glukoza", why].compactMap { $0 }.joined(separator: " · "), state: .planned, isWbt: false, actionTitle: nil, action: nil,
            symbol: "drop.fill", symbolColor: Brand.rescue
        )
    }

    /// A divided meal always offers the whole dose at once (owner 2026-11-09: a later part an hour on is too late for a
    /// soup): the server's "Całość teraz" as "Podaj pełną dawkę", which gives it straight away.
    static let fullDoseLabel = "Podaj pełną dawkę"

    /// The divided card's "Całość teraz": shown as "Podaj pełną dawkę" and given at once (by kind, never by its words).
    static func isFullDoseButton(_ variant: ConversationBolusProposal.Variant, on card: ConversationBolusProposal) -> Bool {
        card.split != nil && variant.kind == "ALL_NOW"
    }

    static func withFullDoseButton(_ card: ConversationBolusProposal) -> ConversationBolusProposal {
        guard let variants = card.variants else { return card }
        var copy = card
        copy.variants = variants.map { variant in
            guard isFullDoseButton(variant, on: card) else { return variant }
            return ConversationBolusProposal.Variant(kind: variant.kind, label: fullDoseLabel, carbs_now_g: variant.carbs_now_g, insulin_now_u: variant.insulin_now_u, later: variant.later, risk: variant.risk, needs_ack: variant.needs_ack, ack_text: variant.ack_text)
        }
        return copy
    }

    /// The card changed as in the chat (one card, owner 2026-11-10): a variant or the rest's reminder.
    private func chooseVariant(_ variant: ConversationBolusProposal.Variant, card: ConversationBolusProposal, entry: MealPlanEntry, host: RemoteBolusHost) async {
        await changeCard(card, kind: variant.kind, rest: nil) { proposal in
            // "Podaj pełną dawkę": the whole dose goes to the confirmation at once.
            if Self.isFullDoseButton(variant, on: card), proposal.canGiveDraft { host.give(proposal.mealPlanDraftBase) }
        }
    }

    private func chooseRest(_ rest: ConversationBolusProposal.RestChoice?, card: ConversationBolusProposal) async {
        await changeCard(card, kind: "REST_LATER", rest: rest) { _ in }
    }

    private func changeCard(_ card: ConversationBolusProposal, kind: String, rest: ConversationBolusProposal.RestChoice?, minutes: Int? = nil, then: (ConversationBolusProposal) -> Void) async {
        variantBusy = true
        defer { variantBusy = false }
        do {
            let response = try await api.changeBolusCard(patientID: patientID, proposalID: card.id, kind: kind, rest: rest, minutes: minutes)
            bolusCard = response.proposal
            then(response.proposal)
            variantError = nil
        } catch {
            variantError = (error as? LocalizedError)?.errorDescription ?? "Nie udało się zmienić planu."
        }
    }

    /// The calculator lowered the dose because glucose is low or falling: the choices the Bolus tab and the chat also have.
    private func loweredDose(_ lowered: MealPlanLoweredDose, entry: MealPlanEntry, calculated: Double?, wholeICR: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(lowered.line)
                .font(.footnote.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            if let icr = lowered.icrDose {
                Button(wholeICR ? "Wróć do mniejszej dawki: \(MealJournalFormat.number(calculated ?? 0)) j" : "Cała dawka teraz, z ostrzeżeniem: \(MealJournalFormat.number(icr)) j") {
                    var changed = plate
                    changed.wholeFromICR = !wholeICR
                    plan.plates[entryID] = changed
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.bordered)
            }
            Button("Bolus później, gdy cukier przestanie spadać") {
                let clock = entry.plannedDate.map { " o \(MealJournalFormat.clock($0))" } ?? ""
                actions.openNewChatWithText("\(entry.title)\(clock): \(plate.described(entry)). Cukier spada: przygotuj węgle teraz, a bolus gdy przestanie spadać.")
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: 44)
        }
    }

    /// Only a suggestion: the dose stays whole until someone chooses.
    private func movementSuggestion(_ ahead: MealPlanMovementAhead, fullDose: Double, smaller: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(ahead.title) jest \(ahead.timeLabel) po tym posiłku, więc można podać mniej insuliny.")
                .font(.footnote.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            if smaller {
                Text("Węglowodany zostają bez zmian, więc pętla może sama dodać trochę insuliny.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(smaller ? "Wróć do całej dawki: \(MealJournalFormat.number(fullDose)) j" : "Podaj o 25% mniej: \(MealJournalFormat.number(MealPlanMovementAhead.reduced(fullDose))) j") {
                var changed = plate
                changed.smallerBeforeMovement = !smaller
                plan.plates[entryID] = changed
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
        }
    }

    private func skipButton(_ entry: MealPlanEntry, title: String = "Pomiń ten posiłek") -> some View {
        Button(title) { Task { await plan.skip(entry) } }
            .font(.subheadline.weight(.semibold))
            .tint(.primary)
            .frame(maxWidth: .infinity, minHeight: 44)
    }

    private func foods(_ entry: MealPlanEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.items.isEmpty ? "Bez jadłospisu dodaj to, co jest na talerzu albo napisz o tym niżej." : entry.menu_changed == true ? "Zmienione w rozmowie niżej, porcje szacunkowe. Stuknij potrawę, żeby zmienić porcję." : "Z jadłospisu, porcje szacunkowe. Stuknij potrawę, żeby zmienić porcję. Zmianę w jadłospisie opisz niżej.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(entry.items) { item in
                MealPlanFoodRow(
                    item: item,
                    food: Binding(get: { plate.food(item) }, set: { food in
                        var changed = plate
                        changed.set(food, for: item)
                        plan.plates[entryID] = changed
                    }),
                    grams: plate.carbs(of: item),
                    note: PatientNote.about(item, in: notes),
                    remember: { portion in
                        if let updated = try? await api.addFoodNote(patientID: patientID, foodName: item.name, portion: portion).notes {
                            notes = updated
                        } else {
                            plan.errorMessage = "Nie udało się zapamiętać. Sprawdź połączenie i spróbuj ponownie."
                        }
                    },
                    splitInChat: {
                        let clock = entry.plannedDate.map { " o \(MealJournalFormat.clock($0))" } ?? ""
                        actions.openNewChatWithText("\(entry.title)\(clock): \(plate.described(entry)). \(item.name) może zostać na talerzu: podziel dawkę na część teraz i resztę po posiłku.")
                    }
                )
            }
            ForEach(plate.added) { item in
                HStack {
                    Text(item.name)
                    Spacer()
                    Text("\(MealJournalFormat.number(item.carbs_g ?? 0)) g").foregroundStyle(.secondary).monospacedDigit()
                    Button {
                        var changed = plate
                        changed.removeAdded(item)
                        plan.plates[entryID] = changed
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Usuń: \(item.name)")
                }
            }
            MealPlanAddFood { name, grams in
                var changed = plate
                changed.add(name: name, grams: grams)
                plan.plates[entryID] = changed
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .mealPageCard()
    }

    /// The same freshness as the Bolus tab's forecast: an old reading gives no dose.
    private func isFresh(_ observedAt: String) -> Bool {
        guard let date = ServerDate.parse(observedAt) else { return false }
        return Date().timeIntervalSince(date) < 10.5 * 60
    }

    private func readDose(_ entry: MealPlanEntry, moment: MealPlanMoment) async {
        guard moment == .soon || moment == .late, let carbs = plate.carbs(of: entry), carbs > 0 else {
            preview = nil
            bolusCard = nil
            return
        }
        previewFailed = false
        // Card A where a dose can be given from here; the preview only when it cannot be made (an older server).
        if remoteBolusHost != nil, let items = plate.eatenItems(entry), !items.isEmpty {
            do {
                let response = try await api.mealPlanBolusCard(patientID: patientID, entryID: entry.id, items: items)
                bolusCard = response.proposal
                bolusCardProblem = response.problem
                variantError = nil
                if response.proposal != nil { return }
            } catch is CancellationError {
                return
            } catch {
                bolusCard = nil
            }
        }
        let minutes = entry.plannedDate.map { max(0, min(60, Int($0.timeIntervalSinceNow / 60))) }
        do {
            preview = try await api.previewRemoteCommand(patientID: patientID, carbsG: carbs, insulinU: nil, bolusStep: Decimal(string: "0.05") ?? 0, mealInMinutes: moment == .soon ? minutes : nil, proposalID: nil)
        } catch is CancellationError {
            return
        } catch {
            preview = nil
            previewFailed = true
        }
    }
}

/// The field being typed in on a planned meal's page, so the page can bring it above the keyboard.
private struct MealPlanFocusedField: PreferenceKey {
    static let defaultValue: String? = nil
    static func reduce(value: inout String?, nextValue: () -> String?) { value = nextValue() ?? value }
}

/// One food of a planned meal: a tap unfolds its portion, other grams and another food.
private struct MealPlanFoodRow: View {
    let item: MealPlanItem
    @Binding var food: MealPlanPlate.Food
    let grams: Double?
    /// A caregiver's note about this food: only suggests, until a choice here.
    let note: PatientNote?
    let remember: (String) async -> Void
    /// A food that may stay on the plate: part of the dose now, the rest when it is known what was eaten.
    let splitInChat: () -> Void
    @State private var suggestionAnswered = false
    @State private var isOpen = false
    @State private var isReplacing = false
    @State private var gramsText = ""
    @State private var nameText = ""
    @FocusState private var isGramsFocused: Bool

    private enum Choice: Hashable { case whole, half, none, other }

    private var choice: Choice {
        switch food.portion {
        case .whole: return .whole
        case .half: return .half
        case .none: return .none
        case .grams: return .other
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { isOpen.toggle() }
            } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(food.replacedBy ?? item.name)
                            .strikethrough(food.portion == .none)
                            .foregroundStyle(food.portion == .none ? Color.secondary : Color.primary)
                        if let noteLine {
                            Text(noteLine).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if let grams {
                        Text("\(MealJournalFormat.number(grams)) g").foregroundStyle(.secondary).monospacedDigit()
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Zmienia porcję tej potrawy")
            if let suggestion { suggestionView(suggestion) }
            if isOpen { editor }
        }
    }

    /// The note, while nothing was chosen: all foods count until then.
    private var suggestion: PatientNote? {
        guard let note, !suggestionAnswered, food == MealPlanPlate.Food() else { return nil }
        return note
    }

    private func suggestionView(_ note: PatientNote) -> some View {
        let half = note.portion == "HALF"
        let who = note.created_by_name.map { "Opiekun \($0) zapisał" } ?? "Zapisano"
        return VStack(alignment: .leading, spacing: 6) {
            Text("\(who), że \(half ? "zwykle zjada połowę tej potrawy" : "ta potrawa zwykle zostaje na talerzu"). Dawka liczy ją w całości, dopóki nie wybierzesz.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(half ? "Policz połowę" : "Nie licz") {
                    food.portion = half ? .half : .none
                    suggestionAnswered = true
                }
                Button("Policz całość") { suggestionAnswered = true }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
            .controlSize(.small)
            Button("Podziel dawkę w czacie") { splitInChat() }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
        }
        .padding(.bottom, 6)
    }

    private var noteLine: String? {
        if food.replacedBy != nil { return "zamiast: \(item.name)" }
        switch food.portion {
        case .whole: return nil
        case .half: return "połowa porcji"
        case .none: return "nie je"
        case .grams: return "inna porcja"
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Another food has only its own grams: a portion of the menu's food would not apply to it.
            if !isReplacing {
                Picker("Porcja", selection: Binding(get: { choice }, set: select)) {
                    Text("Cała").tag(Choice.whole)
                    Text("Połowa").tag(Choice.half)
                    Text("Nie je").tag(Choice.none)
                    Text("Inna").tag(Choice.other)
                }
                .pickerStyle(.segmented)
            }
            if isReplacing {
                TextField("Co zamiast tego?", text: $nameText)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.next)
                    // The grams field sits under the keyboard: return goes there, and the page scrolls to it.
                    .onSubmit { isGramsFocused = true }
                    .onChange(of: nameText) { _, _ in applyReplacement() }
            }
            if choice == .other || isReplacing {
                HStack {
                    Text("Węglowodany").font(.subheadline)
                    Spacer()
                    TextField("0", text: $gramsText)
                        .focused($isGramsFocused)
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                        #if os(iOS)
                        .keyboardType(.decimalPad)
                        #endif
                        .onChange(of: gramsText) { _, text in
                            if let value = MealPlanPlate.grams(from: text) {
                                food.portion = .grams(value)
                            } else if isReplacing {
                                // No number: another food waits for its grams again.
                                food.portion = .whole
                            }
                        }
                    Text("g").foregroundStyle(.secondary)
                }
                .id("grams-\(item.id)")
                .preference(key: MealPlanFocusedField.self, value: isGramsFocused ? "grams-\(item.id)" : nil)
            }
            if food.replacedBy == nil, note == nil, let portion = rememberablePortion {
                Button(portion == "NONE" ? "Zapamiętaj: zwykle zostaje na talerzu" : "Zapamiętaj: zwykle zjada połowę") {
                    Task { await remember(portion) }
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
            }
            HStack {
                if !isReplacing {
                    Button("Zamień na inną potrawę") {
                        isReplacing = true
                        nameText = food.replacedBy ?? ""
                    }
                }
                Spacer()
                if food != MealPlanPlate.Food() || isReplacing {
                    Button("Cofnij zmianę") {
                        food = MealPlanPlate.Food()
                        isReplacing = false
                        nameText = ""
                        gramsText = ""
                    }
                }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.borderless)
            .frame(minHeight: 44)
        }
        .padding(.bottom, 6)
        // What was set stays when the page is opened again.
        .onAppear {
            isReplacing = food.replacedBy != nil
            nameText = food.replacedBy ?? ""
            if case let .grams(value) = food.portion { gramsText = MealJournalFormat.number(value) }
        }
    }

    private var rememberablePortion: String? {
        switch food.portion {
        case .none: return "NONE"
        case .half: return "HALF"
        default: return nil
        }
    }

    private func select(_ choice: Choice) {
        switch choice {
        case .whole: food.portion = .whole
        case .half: food.portion = .half
        case .none: food.portion = .none
        case .other:
            // Starts from what is counted now, so the dose does not jump until the number changes.
            let current = grams ?? 0
            gramsText = MealJournalFormat.number(current)
            food.portion = .grams(current)
        }
    }

    /// Another food has its own grams: until they are typed, the page offers no dose.
    private func applyReplacement() {
        let name = nameText.trimmingCharacters(in: .whitespaces)
        food.replacedBy = name.isEmpty ? nil : name
        if name.isEmpty { return }
        if MealPlanPlate.grams(from: gramsText) == nil { food.portion = .whole }
    }
}

/// A food the menu does not have: its name and grams together, so nothing is counted half typed.
private struct MealPlanAddFood: View {
    let add: (String, Double) -> Void
    @State private var isOpen = false
    @State private var name = ""
    @State private var gramsText = ""

    var body: some View {
        if isOpen {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Nazwa potrawy", text: $name)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Text("Węglowodany").font(.subheadline)
                    Spacer()
                    TextField("0", text: $gramsText)
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                        #if os(iOS)
                        .keyboardType(.decimalPad)
                        #endif
                    Text("g").foregroundStyle(.secondary)
                }
                HStack {
                    Button("Dodaj") {
                        if let grams = MealPlanPlate.grams(from: gramsText) {
                            add(name, grams)
                            name = ""
                            gramsText = ""
                            isOpen = false
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || MealPlanPlate.grams(from: gramsText) == nil)
                    Spacer()
                    Button("Anuluj") { isOpen = false }
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
            }
            .padding(.vertical, 6)
        } else {
            Button("Dodaj potrawę") { isOpen = true }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
        }
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
    /// What the card above already knows: a dose sent, before the list reads it back.
    var noteOverride: String? = nil
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
                if let note = noteOverride ?? row.note {
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
