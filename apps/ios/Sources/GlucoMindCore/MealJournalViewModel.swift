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
        didSet { days = Self.group(items, calendar: calendar) }
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

    public init(patientID: String, api: MealJournalAPI, calendar: Calendar = .polish, now: @escaping () -> Date = Date.init) {
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

    public func bindLiveUpdates(_ live: LiveUpdates?) {
        liveSubscription = live?.changes
            .filter { $0.concerns(anyOf: ["meal", "meals", "remote_command", "loop_action"]) }
            .debounce(for: .milliseconds(400), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.load() }
            }
    }
}
