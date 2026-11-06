import Combine
import Foundation
import SwiftUI

/// The Meals tab: every meal from the chat and Bolus tab boluses with a reminder, newest first, read a page at a time
/// as the list scrolls. The calendar above follows the day at the top of the list; a day tapped in it scrolls the list
/// there (reading older pages first). The search covers every day.
@MainActor
public final class MealJournalViewModel: ObservableObject {
    public enum LoadState: Equatable {
        case loading
        case loaded
        case failed
    }

    public struct Day: Identifiable, Equatable {
        public let day: Date
        public let items: [MealJournalItem]
        public var id: Date { day }
    }

    /// A day tapped in the calendar: the list scrolls to `day` (the tapped one, or the nearest earlier day with meals).
    public struct ScrollRequest: Equatable {
        public let id = UUID()
        public let day: Date
    }

    @Published public private(set) var selectedDay: Date
    @Published public private(set) var displayedMonth: Date
    /// The week the strip shows: the chosen day's, until the arrows move it (the chosen day stays).
    @Published public private(set) var displayedWeekStart: Date
    /// Meals read so far, newest first.
    @Published public private(set) var items: [MealJournalItem] = [] {
        didSet { refreshDays() }
    }
    /// The meals by day, newest first: worked out when the meals change, not on every redraw.
    @Published public private(set) var days: [Day] = []
    @Published public private(set) var loadState: LoadState = .loading
    @Published public private(set) var canLoadMore = false
    @Published public private(set) var isLoadingMore = false
    @Published public private(set) var scrollRequest: ScrollRequest?
    /// "Brak posiłków 23 października": a tapped day without meals (the list shows the nearest earlier one).
    @Published public private(set) var dayNote: String?
    /// Days with a meal (the dots), from the ranges read so far.
    @Published public private(set) var markedDays: Set<Date> = []
    @Published public private(set) var hasLoaded = false
    @Published public private(set) var errorMessage: String?
    /// Reminder switches being saved (their row is disabled meanwhile).
    @Published public private(set) var togglingIDs: Set<String> = []
    @Published public var query = "" {
        didSet { if query != oldValue { scheduleSearch() } }
    }
    @Published public private(set) var searchResults: [MealJournalItem] = []
    @Published public private(set) var isSearching = false
    /// The last search could not be read (not the same as finding nothing).
    @Published public private(set) var searchFailed = false

    public let patientID: String
    public let calendar: Calendar
    private let api: MealJournalAPI
    private let now: () -> Date
    private var shownToday: Date
    private var nextBefore: String?
    /// Months whose dots were read.
    private var markedMonths: Set<Date> = []
    /// After a tap in the calendar the list scrolls on its own: what comes into view meanwhile does not move the
    /// calendar's day.
    private var followsScrollAfter = Date.distantPast
    private var noteTask: Task<Void, Never>?
    private var searchTask: Task<Void, Never>?
    /// The older page being read: a second caller (the end of the list and a calendar tap) waits for the same page.
    private var loadMoreTask: Task<Bool, Never>?
    /// Grows with every day tapped in the calendar: a slower, earlier tap stops once a newer one was made.
    private var selectGeneration = 0
    private var liveSubscription: AnyCancellable?
    static let pageSize = 20
    /// Pages read at most to reach a tapped day (20 meals a page).
    static let maxPagesToReachDay = 30

    public init(patientID: String, api: MealJournalAPI, calendar: Calendar = .polish, undoSeconds: TimeInterval = 10, now: @escaping () -> Date = Date.init) {
        self.undoSeconds = undoSeconds
        self.patientID = patientID
        self.api = api
        self.calendar = calendar
        self.now = now
        let today = calendar.startOfDay(for: now())
        selectedDay = today
        shownToday = today
        displayedMonth = calendar.dateInterval(of: .month, for: today)?.start ?? today
        displayedWeekStart = calendar.dateInterval(of: .weekOfYear, for: today)?.start ?? today
    }

    public var isSearchActive: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public var isSelectedDayToday: Bool { calendar.isDate(selectedDay, inSameDayAs: now()) }

    private static func group(_ items: [MealJournalItem], calendar: Calendar) -> [Day] {
        let dated = items.map { (item: $0, date: $0.startedDate ?? .distantPast) }
        let grouped = Dictionary(grouping: dated) { calendar.startOfDay(for: $0.date) }
        return grouped.keys.sorted(by: >).map { day in
            Day(day: day, items: (grouped[day] ?? []).sorted { $0.date > $1.date }.map(\.item))
        }
    }

    /// The tab appears, the app comes back or something changed: the newest page read again (older pages already read
    /// stay), with the dots of the month on screen.
    public func load() async {
        let today = calendar.startOfDay(for: now())
        if today != shownToday {
            if selectedDay == shownToday { setDay(today) }
            shownToday = today
        }
        async let page: Void = loadFirstPage()
        async let dots: Void = loadMarkers(for: displayedMonth, force: true)
        _ = await (page, dots)
        hasLoaded = true
    }

    /// The end of the list came into view: the next older page (a page already on its way is waited for, not read
    /// twice). True when it moved on (new meals or an older cursor); false when it failed or brought nothing new.
    @discardableResult
    public func loadMore() async -> Bool {
        if let running = loadMoreTask { return await running.value }
        guard canLoadMore, let before = nextBefore else { return false }
        // Not cancelled with its caller: the other caller waiting for the same page still gets it.
        let task = Task { [weak self] () -> Bool in
            await self?.readPage(before: before) ?? false
        }
        loadMoreTask = task
        isLoadingMore = true
        let added = await task.value
        loadMoreTask = nil
        isLoadingMore = false
        return added
    }

    private func readPage(before: String) async -> Bool {
        guard let page = try? await api.listMealJournal(patientID: patientID, before: before, after: nil, limit: Self.pageSize) else { return false }
        let known = Set(items.map(\.meal_id))
        let fresh = page.items.filter { !known.contains($0.meal_id) }
        items += fresh
        nextBefore = page.next_before
        canLoadMore = page.next_before != nil
        return !fresh.isEmpty || (page.next_before.map { $0 != before } ?? false)
    }

    /// A day tapped in the calendar: older pages are read until it is reached, then the list scrolls to it, or to the
    /// nearest earlier day with meals ("Brak posiłków …" for a moment).
    public func select(_ day: Date) async {
        guard !isFuture(day) else { return }
        selectGeneration += 1
        let generation = selectGeneration
        let start = calendar.startOfDay(for: day)
        setDay(start)
        followsScrollAfter = now().addingTimeInterval(1.2)
        var pages = 0
        while canLoadMore, pages < Self.maxPagesToReachDay, (items.last?.startedDate).map({ calendar.startOfDay(for: $0) > start }) ?? true {
            let added = await loadMore()
            // A newer tap took over; a failed or empty page would only be read again (offline: 30 times).
            guard generation == selectGeneration else { return }
            guard added else { break }
            pages += 1
        }
        async let dots: Void = loadMarkers(for: monthStart(of: start), force: false)
        let shown = days
        guard let target = shown.first(where: { $0.day <= start }) ?? shown.last else { await dots; return }
        showNote(target.day == start ? nil : "Brak posiłków \(MealJournalFormat.shortDay(start, calendar: calendar))")
        followsScrollAfter = now().addingTimeInterval(1.2)
        scrollRequest = ScrollRequest(day: target.day)
        await dots
    }

    /// The days whose meals are in view (the list's top is the newest): the calendar marks the top one.
    public func visibleDaysChanged(_ visible: Set<Date>) {
        guard now() >= followsScrollAfter, let top = visible.max(), top != selectedDay else { return }
        // The mark slides to the new day (and the strip to its week) rather than jumping.
        withAnimation(.snappy(duration: 0.3)) { setDay(top) }
        Task { await loadMarkers(for: monthStart(of: top), force: false) }
    }

    /// Shows the month and day of a moment.
    public func focus(on date: Date, reload: Bool = false) async {
        displayedMonth = monthStart(of: date)
        if reload { markedMonths.remove(monthStart(of: date)) }
        await select(date)
    }

    public func goToToday() async {
        await select(now())
    }

    public func showMonth(offset: Int) async {
        guard let month = calendar.date(byAdding: .month, value: offset, to: displayedMonth) else { return }
        guard monthStart(of: month) <= monthStart(of: now()) else { return }
        displayedMonth = monthStart(of: month)
        await loadMarkers(for: displayedMonth, force: false)
    }

    public var canShowNextMonth: Bool { monthStart(of: displayedMonth) < monthStart(of: now()) }

    private func setDay(_ day: Date) {
        selectedDay = day
        displayedWeekStart = weekStart(of: day)
        displayedMonth = monthStart(of: day)
    }

    private func showNote(_ note: String?) {
        noteTask?.cancel()
        dayNote = note
        guard note != nil else { return }
        noteTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            self?.dayNote = nil
        }
    }

    private func loadFirstPage() async {
        do {
            let page = try await api.listMealJournal(patientID: patientID, before: nil, after: nil, limit: Self.pageSize)
            // Older pages already read stay below the fresh first one.
            let oldest = page.items.compactMap(\.startedDate).min()
            let fresh = Set(page.items.map(\.meal_id))
            let older = page.next_before == nil ? [] : items.filter { item in
                !fresh.contains(item.meal_id) && (item.startedDate.map { date in oldest.map { date < $0 } ?? false } ?? false)
            }
            items = page.items + older
            if older.isEmpty {
                nextBefore = page.next_before
                canLoadMore = page.next_before != nil
            }
            // The last action's error stays: a reload right after it (a conflict) must not hide it.
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            if items.isEmpty { loadState = .failed }
        }
    }

    public func setReminder(mealID: String, reminderID: String, enabled: Bool) async {
        let key = "\(mealID)/\(reminderID)"
        guard !togglingIDs.contains(key) else { return }
        togglingIDs.insert(key)
        defer { togglingIDs.remove(key) }
        errorMessage = nil
        do {
            let response = try await api.setMealReminder(patientID: patientID, mealID: mealID, reminderID: reminderID, enabled: enabled)
            if let index = items.firstIndex(where: { $0.meal_id == mealID }) { items[index] = response.item }
        } catch APIClientError.conflict {
            errorMessage = "To przypomnienie już przyszło albo wygasło."
            await load()
        } catch {
            errorMessage = "Nie udało się zapisać. Sprawdź połączenie i spróbuj ponownie."
        }
    }

    public func clearError() { errorMessage = nil }

    // MARK: Calendar

    /// Monday to Sunday of the week the strip shows (the chosen day's, unless the arrows moved it).
    public var weekOfSelectedDay: [Date] {
        (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: displayedWeekStart) }
    }

    /// The strip's arrows move the week only: the chosen day and its meals stay.
    public func showWeek(offset: Int) async {
        guard let start = calendar.date(byAdding: .day, value: 7 * offset, to: displayedWeekStart), !isFuture(start) else { return }
        displayedWeekStart = start
        // Dots of the week's months (a week can span two).
        await loadMarkers(for: monthStart(of: start), force: false)
        if let end = calendar.date(byAdding: .day, value: 6, to: start), monthStart(of: end) != monthStart(of: start) {
            await loadMarkers(for: monthStart(of: end), force: false)
        }
    }

    public var canShowNextWeek: Bool {
        guard let next = calendar.date(byAdding: .day, value: 7, to: displayedWeekStart) else { return false }
        return !isFuture(next)
    }

    private func weekStart(of date: Date) -> Date {
        calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? calendar.startOfDay(for: date)
    }

    /// Days of the displayed month, padded with nils so the first day sits under its weekday.
    public var monthGrid: [Date?] {
        guard let range = calendar.range(of: .day, in: .month, for: displayedMonth) else { return [] }
        let firstWeekday = calendar.component(.weekday, from: displayedMonth)
        let leading = (firstWeekday - calendar.firstWeekday + 7) % 7
        let days = range.compactMap { calendar.date(byAdding: .day, value: $0 - 1, to: displayedMonth) }
        return Array(repeating: nil, count: leading) + days.map { Optional($0) }
    }

    public var weekdaySymbols: [String] {
        let symbols = calendar.veryShortStandaloneWeekdaySymbols
        let start = calendar.firstWeekday - 1
        return Array(symbols[start...] + symbols[..<start])
    }

    /// Short weekday name of a day ("pn", "wt").
    public func shortWeekday(_ day: Date) -> String {
        let symbol = calendar.shortStandaloneWeekdaySymbols[calendar.component(.weekday, from: day) - 1]
        return symbol.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
    }

    public func isFuture(_ day: Date) -> Bool {
        calendar.startOfDay(for: day) > calendar.startOfDay(for: now())
    }

    public func marker(for day: Date) -> MealsDayMarker {
        markedDays.contains(calendar.startOfDay(for: day)) ? .entries : .none
    }

    private func monthStart(of date: Date) -> Date {
        calendar.dateInterval(of: .month, for: date)?.start ?? calendar.startOfDay(for: date)
    }

    /// The dots of a month and the week around its edges (the strip shows days of the next or the previous month).
    private func loadMarkers(for month: Date, force: Bool) async {
        guard force || !markedMonths.contains(month) else { return }
        guard let from = calendar.date(byAdding: .day, value: -7, to: month),
              let monthEnd = calendar.date(byAdding: .month, value: 1, to: month),
              let to = calendar.date(byAdding: .day, value: 7, to: monthEnd) else { return }
        guard let response = try? await api.listMealJournalDays(patientID: patientID, from: ServerDate.string(from), to: ServerDate.string(to)) else { return }
        let days = Set(response.starts.compactMap(ServerDate.parse).map { calendar.startOfDay(for: $0) })
        let range = from..<to
        markedDays = markedDays.filter { !range.contains($0) }.union(days)
        markedMonths.insert(month)
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            searchResults = []
            isSearching = false
            searchFailed = false
            return
        }
        isSearching = true
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self, !Task.isCancelled else { return }
            let results = try? await self.api.searchMeals(patientID: self.patientID, query: text)
            guard !Task.isCancelled else { return }
            self.searchResults = results?.items ?? []
            self.searchFailed = results == nil
            self.isSearching = false
        }
    }

    // MARK: Merge ("Scal")

    /// What the merge waits for: the app asks before it is done (meal-merge.v1).
    public enum MergeQuestion: Equatable {
        /// Several meals have their own description or values: they are reset and entered again.
        case confirmReset
        /// One meal has a later part still to come: keep its split, or work out a new one in the chat.
        case chooseSplit
    }

    /// "Nowy podział w czacie": a new chat with this text ready to send.
    public struct MergeChatRequest: Equatable {
        public let id = UUID()
        public let text: String
    }

    /// The tiles can be ticked for "Scal".
    @Published public private(set) var isSelecting = false
    /// Ticked meals, in the order they were ticked.
    @Published public private(set) var selectedMealIDs: [String] = []
    @Published public private(set) var isMerging = false
    @Published public private(set) var mergeQuestion: MergeQuestion?
    @Published public private(set) var mergeChatRequest: MergeChatRequest?
    /// The meal a merge just made: the tab brings it into view and marks it for a moment (its frame lights up).
    @Published public private(set) var justMergedMealID: String?
    /// How the ticked meals fold into the merged one.
    public static let mergeAnimation: Animation = .spring(response: 0.5, dampingFraction: 0.82)
    private var pendingMerge: (ids: [String], preview: MealMergePreview, resetConfirmed: Bool)?

    public var canMergeSelection: Bool { selectedMealIDs.count >= 2 && !isMerging }

    /// Meals merged together fit in this window, first to last start (the meal page's chart; the server's
    /// MEAL_MERGE_POLICY.max_span_hours).
    public static let mergeMaxSpan: TimeInterval = 4 * 3_600

    /// Ticked meals can always be unticked; another meal only when it keeps all of them within 4 hours.
    public func canSelect(_ item: MealJournalItem) -> Bool {
        if selectedMealIDs.contains(item.meal_id) { return true }
        guard let start = item.startedDate else { return false }
        let ticked = items.filter { selectedMealIDs.contains($0.meal_id) }.compactMap(\.startedDate)
        guard let first = (ticked + [start]).min(), let last = (ticked + [start]).max() else { return true }
        return last.timeIntervalSince(first) <= Self.mergeMaxSpan
    }

    /// Some meal on the list cannot be ticked any more (the bar says why).
    public var hasMealsOutsideMergeWindow: Bool {
        !selectedMealIDs.isEmpty && items.contains { !canSelect($0) }
    }

    public func startSelecting() {
        commitUndoableChange()
        selectedMealIDs = []
        isSelecting = true
    }

    /// A meal held down: "Scal" starts with it ticked (a hold while ticking ticks it like a tap).
    public func startSelecting(with mealID: String) {
        guard !isMerging, !isSearchActive else { return }
        if !isSelecting { startSelecting() }
        if !selectedMealIDs.contains(mealID) { toggleSelection(mealID) }
    }

    public func cancelSelecting() {
        isSelecting = false
        selectedMealIDs = []
        pendingMerge = nil
        mergeQuestion = nil
    }

    public func toggleSelection(_ mealID: String) {
        guard isSelecting, !isMerging else { return }
        if let index = selectedMealIDs.firstIndex(of: mealID) {
            selectedMealIDs.remove(at: index)
        } else {
            guard let item = items.first(where: { $0.meal_id == mealID }), canSelect(item) else { return }
            selectedMealIDs.append(mealID)
        }
    }

    /// "Scal": the server says first what the merge would do; a question waits for the caregiver, else it is done.
    public func mergeSelected() async {
        guard canMergeSelection else { return }
        await finishSending()
        let ids = selectedMealIDs
        errorMessage = nil
        isMerging = true
        let preview: MealMergePreview
        do {
            preview = try await api.previewMealMerge(patientID: patientID, mealIDs: ids).merge
        } catch {
            isMerging = false
            errorMessage = Self.mergeErrorText(error)
            return
        }
        isMerging = false
        guard preview.ok else {
            errorMessage = preview.message ?? "Tych posiłków nie można scalić."
            return
        }
        pendingMerge = (ids, preview, false)
        await continueMerge()
    }

    /// "Scal i wpisz od nowa" in the reset question.
    public func confirmMergeReset() async {
        guard pendingMerge != nil else { return }
        mergeQuestion = nil
        pendingMerge?.resetConfirmed = true
        await continueMerge()
    }

    /// "Zostaw podział" or "Nowy podział w czacie".
    public func chooseMergeSplit(_ choice: MealMergeSplitChoice) async {
        guard pendingMerge != nil else { return }
        mergeQuestion = nil
        await performMerge(split: choice)
    }

    /// A question closed with "Anuluj": nothing is merged, the ticks stay.
    public func cancelMergeQuestion() {
        mergeQuestion = nil
        pendingMerge = nil
    }

    public func mergeChatHandled(_ request: MergeChatRequest) {
        if mergeChatRequest == request { mergeChatRequest = nil }
    }

    /// The merged meal's mark has faded.
    public func mergedHighlightEnded(_ mealID: String) {
        if justMergedMealID == mealID { justMergedMealID = nil }
    }

    private func continueMerge() async {
        guard let pending = pendingMerge else { return }
        if pending.preview.content == .reset, !pending.resetConfirmed {
            mergeQuestion = .confirmReset
        } else if pending.preview.split == true {
            mergeQuestion = .chooseSplit
        } else {
            await performMerge(split: nil)
        }
    }

    /// The merge is shown at once and sent when its "Cofnij" bar goes. "Nowy podział w czacie" leaves for the chat, so
    /// it is sent straight away, with no bar.
    private func performMerge(split: MealMergeSplitChoice?) async {
        guard let pending = pendingMerge else { return }
        pendingMerge = nil
        let chosen = items.filter { pending.ids.contains($0.meal_id) }
        guard split == .resplit else {
            let targetID = pending.preview.meal_id ?? pending.ids[0]
            let merged = Self.mergedItem(chosen, targetID: targetID, reset: pending.preview.content == .reset)
            let count = pending.ids.count
            let change = UndoableChange(
                title: "Scalono \(count) \(PolishPlural.meals(count))",
                note: "Bolusy i przypomnienia są teraz w jednym posiłku.",
                seconds: undoSeconds,
                action: .merge(ids: pending.ids, targetID: targetID, resetConfirmed: pending.resetConfirmed, split: split, merged: merged)
            )
            beginUndoable(change) {
                isSelecting = false
                selectedMealIDs = []
                justMergedMealID = targetID
            }
            return
        }
        isMerging = true
        defer { isMerging = false }
        do {
            let response = try await api.mergeMeals(patientID: patientID, mealIDs: pending.ids, resetConfirmed: pending.resetConfirmed, split: split)
            // The merged-away meals fold into the merged one at once (also from older pages the reload keeps).
            withAnimation(Self.mergeAnimation) {
                applyMerge(response, ids: pending.ids)
                isSelecting = false
                selectedMealIDs = []
                justMergedMealID = response.meal_id
            }
            mergeChatRequest = MergeChatRequest(text: Self.resplitPrompt(merged: response.item, parts: chosen))
            await load()
        } catch {
            errorMessage = Self.mergeErrorText(error)
            await load()
        }
    }

    private func applyMerge(_ response: MealMergeResponse, ids: [String]) {
        items = items.compactMap { item in
            if item.meal_id == response.meal_id { return response.item }
            return ids.contains(item.meal_id) ? nil : item
        }
    }

    /// The merged meal as the list shows it until the server has merged it: its earliest start, all carbs and insulin.
    static func mergedItem(_ chosen: [MealJournalItem], targetID: String, reset: Bool) -> MealJournalItem {
        let target = chosen.first { $0.meal_id == targetID } ?? chosen[0]
        let earliest = chosen.min { ($0.startedDate ?? .distantFuture) < ($1.startedDate ?? .distantFuture) } ?? target
        let carbs = chosen.compactMap(\.carbs_g)
        let insulin = chosen.compactMap(\.insulin_total_u)
        let described = reset ? nil : chosen.first { !($0.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return MealJournalItem(
            meal_id: target.meal_id,
            started_at: earliest.started_at,
            title: described?.title,
            carbs_g: carbs.isEmpty ? nil : carbs.reduce(0, +),
            insulin_total_u: insulin.isEmpty ? nil : insulin.reduce(0, +),
            source: target.source,
            conversation_id: target.conversation_id,
            has_macros: !reset && chosen.contains(where: \.has_macros),
            reminders: mergedReminders(chosen)
        )
    }

    /// As the server keeps them: one WBT reminder and one second dose per meal, in the order of their time.
    private static func mergedReminders(_ chosen: [MealJournalItem]) -> [MealJournalReminder] {
        var seen: Set<MealJournalReminder.Kind> = []
        return chosen.flatMap(\.reminders)
            .sorted { $0.due_at < $1.due_at }
            .filter { $0.kind == .plannedPart || seen.insert($0.kind).inserted }
    }

    // MARK: Delete ("Usuń") and "Cofnij"

    /// A delete or a merge: the list shows it at once, the server hears of it when its "Cofnij" bar goes. Until then
    /// nothing has changed for the other caregiver, and "Cofnij" has nothing to put back on the server.
    public struct UndoableChange: Identifiable, Equatable {
        public let id = UUID()
        public let title: String
        public let note: String?
        public let seconds: TimeInterval
        fileprivate let action: Action
        /// The bar's second line for a delete names the patient's loop system, which the view knows.
        public var isDelete: Bool {
            if case .delete = action { return true }
            return false
        }

        fileprivate enum Action {
            case delete(mealID: String)
            case merge(ids: [String], targetID: String, resetConfirmed: Bool, split: MealMergeSplitChoice?, merged: MealJournalItem)
        }

        public static func == (lhs: UndoableChange, rhs: UndoableChange) -> Bool { lhs.id == rhs.id }
    }

    /// Deleting a meal with a dose still to come is asked first: its reminder would not come.
    public struct DeleteQuestion: Identifiable, Equatable {
        public let id: String
        public let text: String
    }

    /// The change whose "Cofnij" bar is on screen.
    @Published public private(set) var undoableChange: UndoableChange?
    @Published public private(set) var deleteQuestion: DeleteQuestion?
    private let undoSeconds: TimeInterval
    /// Changes the list already shows: the one on the bar and those on their way to the server.
    private var shownChanges: [UndoableChange] = [] {
        didSet { refreshDays() }
    }
    private var undoTask: Task<Void, Never>?
    /// Changes reach the server one after another, in the order they were made.
    private var sendTask: Task<Void, Never>?

    private func refreshDays() {
        days = Self.group(shownChanges.reduce(items) { Self.applying($1, to: $0) }, calendar: calendar)
    }

    private static func applying(_ change: UndoableChange, to items: [MealJournalItem]) -> [MealJournalItem] {
        switch change.action {
        case let .delete(mealID):
            return items.filter { $0.meal_id != mealID }
        case let .merge(ids, targetID, _, _, merged):
            return items.compactMap { item in
                if item.meal_id == targetID { return merged }
                return ids.contains(item.meal_id) ? nil : item
            }
        }
    }

    /// "Usuń": at once, or after a question when a dose of this meal is still to come.
    public func requestDelete(_ mealID: String) {
        guard let item = items.first(where: { $0.meal_id == mealID }) else { return }
        if let text = Self.waitingDoseText(item) {
            deleteQuestion = DeleteQuestion(id: mealID, text: text)
        } else {
            delete(item)
        }
    }

    public func confirmDelete() {
        guard let question = deleteQuestion else { return }
        deleteQuestion = nil
        if let item = items.first(where: { $0.meal_id == question.id }) { delete(item) }
    }

    public func cancelDelete() { deleteQuestion = nil }

    private func delete(_ item: MealJournalItem) {
        beginUndoable(UndoableChange(
            title: "Usunięto: \(item.displayTitle)",
            note: nil,
            seconds: undoSeconds,
            action: .delete(mealID: item.meal_id)
        )) {}
    }

    /// Deleting a meal does not take anything back from the loop, and the bar says so.
    public static func deleteNote(loop names: LoopSystemNames) -> String {
        let who = names.genitive == "pętli" ? "pętli" : "\(names.genitive) i pętli"
        return "Posiłek usunięty jedynie z Mellis, dla \(who) jest nadal widoczny."
    }

    static func waitingDoseText(_ item: MealJournalItem, timeZone: TimeZone = .current) -> String? {
        let waiting = item.reminders.filter { $0.status == .waiting || $0.status == .dueNow }
        if let part = waiting.first(where: { $0.kind == .plannedPart }) {
            let time = part.isRising ? "" : part.dueDate.map { " o \(MealJournalFormat.clock($0, timeZone: timeZone))" } ?? ""
            return "Ten posiłek czeka na drugą część bolusa\(time). Po usunięciu przypomnienie o tej części nie przyjdzie."
        }
        if let dose = waiting.first(where: { $0.kind == .secondDose }) {
            let time = dose.isRising ? "" : dose.dueDate.map { " o \(MealJournalFormat.clock($0, timeZone: timeZone))" } ?? ""
            return "Ten posiłek czeka na drugą dawkę\(time). Po usunięciu przypomnienie o tej dawce nie przyjdzie."
        }
        return nil
    }

    private func beginUndoable(_ change: UndoableChange, alongside: () -> Void) {
        commitUndoableChange()
        withAnimation(Self.mergeAnimation) {
            alongside()
            shownChanges.append(change)
            undoableChange = change
        }
        // Holds the model on purpose: the change is still sent when the tab's view has gone meanwhile.
        undoTask = Task { [self] in
            try? await Task.sleep(for: .seconds(change.seconds))
            guard !Task.isCancelled else { return }
            commitUndoableChange()
        }
    }

    /// "Cofnij": nothing was sent, so the list only goes back to what the server has.
    public func undoChange() {
        guard let change = undoableChange else { return }
        undoTask?.cancel()
        undoTask = nil
        withAnimation(Self.mergeAnimation) {
            undoableChange = nil
            shownChanges.removeAll { $0.id == change.id }
            justMergedMealID = nil
        }
    }

    /// The bar's time is up, it was thrown down, another change began or the app is leaving: the change is sent now.
    public func commitUndoableChange() {
        guard let change = undoableChange else { return }
        undoTask?.cancel()
        undoTask = nil
        withAnimation(.snappy(duration: 0.25)) { undoableChange = nil }
        let previous = sendTask
        sendTask = Task { [self] in
            await previous?.value
            await send(change)
        }
    }

    /// Waits for the changes on their way to the server.
    public func finishSending() async {
        commitUndoableChange()
        await sendTask?.value
    }

    private func send(_ change: UndoableChange) async {
        do {
            switch change.action {
            case let .delete(mealID):
                do {
                    _ = try await api.deleteMeal(patientID: patientID, mealID: mealID)
                } catch APIClientError.notFound {
                    // Gone already (merged or deleted on the other phone): what was asked for is true.
                }
                withAnimation(Self.mergeAnimation) {
                    shownChanges.removeAll { $0.id == change.id }
                    items.removeAll { $0.meal_id == mealID }
                }
            case let .merge(ids, _, resetConfirmed, split, _):
                let response = try await api.mergeMeals(patientID: patientID, mealIDs: ids, resetConfirmed: resetConfirmed, split: split)
                withAnimation(Self.mergeAnimation) {
                    shownChanges.removeAll { $0.id == change.id }
                    applyMerge(response, ids: ids)
                }
            }
        } catch {
            withAnimation(Self.mergeAnimation) {
                shownChanges.removeAll { $0.id == change.id }
                justMergedMealID = nil
            }
            if case .delete = change.action {
                errorMessage = Self.deleteErrorText(error)
            } else {
                errorMessage = Self.mergeErrorText(error)
            }
        }
        await load()
    }

    static func deleteErrorText(_ error: Error) -> String {
        if case let .conflict(problem)? = error as? APIClientError, let title = problem?.title {
            if let range = title.range(of: #"^[A-Z_]+: "#, options: .regularExpression) { return String(title[range.upperBound...]) }
            return title
        }
        return "Nie udało się usunąć posiłku, więc wrócił na listę. Sprawdź połączenie i spróbuj ponownie."
    }

    /// The server's own words for a refused merge ("MEAL_MERGE_SEVERAL_SPLIT: Więcej niż …" → "Więcej niż …").
    static func mergeErrorText(_ error: Error) -> String {
        if case let .conflict(problem)? = error as? APIClientError, let title = problem?.title {
            if let range = title.range(of: #"^[A-Z_]+: "#, options: .regularExpression) { return String(title[range.upperBound...]) }
            return title
        }
        if case .notFound? = error as? APIClientError {
            return "Któregoś z zaznaczonych posiłków już nie ma. Lista została odświeżona."
        }
        return "Nie udało się scalić posiłków. Sprawdź połączenie i spróbuj ponownie."
    }

    /// The chat's first message after "Nowy podział w czacie": what the merged meal is and what to work out again.
    static func resplitPrompt(merged: MealJournalItem, parts: [MealJournalItem], timeZone: TimeZone = .current) -> String {
        let times = parts.compactMap(\.startedDate).sorted().map { MealJournalFormat.clock($0, timeZone: timeZone) }
        let when: String
        switch times.count {
        case 0: when = ""
        case 1: when = " z \(times[0])"
        default: when = " z \(times.dropLast().joined(separator: ", ")) i \(times[times.count - 1])"
        }
        var facts: [String] = []
        if let carbs = merged.carbs_g { facts.append("\(MealJournalFormat.number(carbs)) g węglowodanów") }
        if let insulin = merged.insulin_total_u { facts.append("podano już \(MealJournalFormat.number(insulin)) j insuliny") }
        let summary = facts.isEmpty ? "" : ": " + facts.joined(separator: ", ")
        return "Posiłki\(when) zostały scalone w jeden posiłek\(summary). Zaplanowana wcześniej kolejna część bolusa została pominięta. "
            + "Policz na nowo podział bolusa dla całego posiłku: ile insuliny trzeba jeszcze podać i kiedy."
    }

    /// The other caregiver (or the loop) changes meals and reminders: the tab reads them again.
    public func bindLiveUpdates(_ live: LiveUpdates?) {
        liveSubscription = live?.changes
            .filter { $0.concerns(anyOf: ["meal", "meals", "remote_command", "loop_action"]) }
            .debounce(for: .milliseconds(400), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.load() }
            }
    }
}

/// One meal's page: the chart, the insulin, the description, the timeline with its reminders.
@MainActor
public final class MealOverviewViewModel: ObservableObject {
    @Published public private(set) var overview: MealOverview?
    /// The page could not be read (shown in place of the page while nothing was read).
    @Published public private(set) var loadErrorMessage: String?
    /// The last action failed (an alert over the page); the next action clears it, a reload does not.
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var togglingIDs: Set<String> = []

    public let patientID: String
    public let mealID: String
    private let api: MealJournalAPI
    private var liveSubscription: AnyCancellable?
    private var seenPartID: String?

    public init(patientID: String, mealID: String, api: MealJournalAPI) {
        self.patientID = patientID
        self.mealID = mealID
        self.api = api
    }

    public func load() async {
        do {
            overview = try await api.getMealOverview(patientID: patientID, mealID: mealID).overview
            loadErrorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            if overview == nil { loadErrorMessage = "Nie udało się wczytać posiłku. Sprawdź połączenie i spróbuj ponownie." }
        }
    }

    public func setReminder(id reminderID: String, enabled: Bool) async {
        guard !togglingIDs.contains(reminderID) else { return }
        togglingIDs.insert(reminderID)
        defer { togglingIDs.remove(reminderID) }
        errorMessage = nil
        do {
            _ = try await api.setMealReminder(patientID: patientID, mealID: mealID, reminderID: reminderID, enabled: enabled)
        } catch APIClientError.conflict {
            errorMessage = "To przypomnienie już przyszło albo wygasło."
        } catch {
            errorMessage = "Nie udało się zapisać. Sprawdź połączenie i spróbuj ponownie."
        }
        await load()
    }

    public func clearError() { errorMessage = nil }

    /// A reminder whose moment came: the page offers the Bolus tab and the chat.
    public var dueReminder: MealJournalReminder? {
        overview?.item.reminders.first { $0.status == .dueNow }
    }

    /// The planned part whose moment came: the page gives it as itself. Stays once seen, so the page can go on to say
    /// what happened to it after it was sent (its reminder is no longer due then).
    public var duePlannedPartID: String? {
        if let due = dueReminder, due.kind == .plannedPart {
            seenPartID = due.id
            return due.id
        }
        return seenPartID
    }

    public func bindLiveUpdates(_ live: LiveUpdates?) {
        liveSubscription = live?.changes
            .filter { $0.concerns(anyOf: ["meal", "meals", "remote_command", "loop_action"]) }
            .debounce(for: .milliseconds(400), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.load() }
            }
    }
}
