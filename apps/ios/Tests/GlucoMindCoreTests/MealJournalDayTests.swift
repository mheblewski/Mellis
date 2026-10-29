import XCTest
@testable import GlucoMindCore

final class MealWbtReminderStateTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_761_465_600) // a meal's start

    private func reminder(_ status: String, fired: String? = nil) throws -> MealJournalReminder {
        let due = ISO8601DateFormatter().string(from: start.addingTimeInterval(150 * 60))
        let firedJSON = fired.map { "\"\($0)\"" } ?? "null"
        let json = #"{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"\#(due)","wait_until":null,"status":"\#(status)","enabled":\#(status == "OFF" ? "false" : "true"),"fired_at":\#(firedJSON)}"#
        return try JSONDecoder().decode(MealJournalReminder.self, from: Data(json.utf8))
    }

    func testOfferedOffUntilTwoAndAHalfHoursAfterTheMeal() {
        let state = MealWbtReminderState(reminder: nil, mealStart: start, now: start.addingTimeInterval(60 * 60))
        XCTAssertFalse(state.isOn)
        XCTAssertTrue(state.canSwitch)
        XCTAssertTrue(state.note?.hasSuffix("2,5 h po posiłku") == true)
    }

    func testNotOfferedOnceTwoAndAHalfHoursPassed() throws {
        for reminder in [nil, try reminder("OFF")] {
            let state = MealWbtReminderState(reminder: reminder, mealStart: start, now: start.addingTimeInterval(151 * 60))
            XCTAssertFalse(state.canSwitch)
            XCTAssertEqual(state.note, "Minęło już 2,5 h od posiłku")
        }
    }

    func testAWaitingReminderCanBeSwitchedOff() throws {
        let state = MealWbtReminderState(reminder: try reminder("WAITING"), mealStart: start, now: start.addingTimeInterval(60 * 60))
        XCTAssertTrue(state.isOn)
        XCTAssertTrue(state.canSwitch)
    }

    func testOneThatCameOrWasGivenOnlySaysSo() throws {
        let sent = MealWbtReminderState(reminder: try reminder("SENT", fired: "2025-10-26T10:31:00Z"), mealStart: start, now: start.addingTimeInterval(200 * 60))
        XCTAssertTrue(sent.isOn)
        XCTAssertFalse(sent.canSwitch)
        XCTAssertTrue(sent.note?.hasPrefix("Przypomnienie przyszło o") == true)
        let given = MealWbtReminderState(reminder: try reminder("GIVEN"), mealStart: start, now: start.addingTimeInterval(200 * 60))
        XCTAssertEqual(given.note, "WBT podane")
        XCTAssertFalse(given.canSwitch)
    }
}

@MainActor
final class MealJournalDayTests: XCTestCase {
    private final class FakeAPI: MealJournalAPI {
        var pageQueries: [String?] = []
        /// before == nil → first page, then the older one.
        var pages: [String?: (items: [String], next: String?)] = [:]
        var starts: [String] = []
        /// Older pages cannot be read (offline).
        var olderPagesFail = false
        /// What a reminder switch answers.
        var reminderError: Error?
        var searchFails = false

        func listMealJournal(patientID: String, before: String?, after: String?, limit: Int) async throws -> MealJournalResponse {
            pageQueries.append(before)
            if before != nil, olderPagesFail { throw URLError(.notConnectedToInternet) }
            let page = pages[before] ?? ([], nil)
            let next = page.next.map { "\"\($0)\"" } ?? "null"
            let json = #"{"patient_id":"p","items":[\#(page.items.joined(separator: ","))],"next_before":\#(next)}"#
            return try JSONDecoder().decode(MealJournalResponse.self, from: Data(json.utf8))
        }
        func listMealJournalDays(patientID: String, from: String, to: String) async throws -> MealJournalDaysResponse {
            MealJournalDaysResponse(starts: starts)
        }
        func searchMeals(patientID: String, query: String) async throws -> MealSearchResponse {
            if searchFails { throw URLError(.notConnectedToInternet) }
            return try JSONDecoder().decode(MealSearchResponse.self, from: Data(#"{"patient_id":"p","query":"x","items":[]}"#.utf8))
        }
        func getMealOverview(patientID: String, mealID: String) async throws -> MealOverviewResponse {
            let json = #"{"patient_id":"p","overview":{"meal_id":"m1","started_at":"2026-10-26T08:00:00Z","title":null,"carbs_g":10,"insulin_total_u":1,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[]}}"#
            return try JSONDecoder().decode(MealOverviewResponse.self, from: Data(json.utf8))
        }
        func setMealReminder(patientID: String, mealID: String, reminderID: String, enabled: Bool) async throws -> MealReminderToggleResponse {
            throw reminderError ?? URLError(.badURL)
        }
    }

    private static func item(_ id: String, _ startedAt: String) -> String {
        #"{"meal_id":"\#(id)","started_at":"\#(startedAt)","title":null,"carbs_g":10,"insulin_total_u":1,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[]}"#
    }

    private static let iso = ISO8601DateFormatter()

    private func model() -> (MealJournalViewModel, FakeAPI, Calendar) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        calendar.firstWeekday = 2
        let now = Self.iso.date(from: "2026-10-26T12:00:00Z")!
        let api = FakeAPI()
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("sat", "2026-10-24T08:00:00Z")], "2026-10-24T08:00:00Z")
        api.pages["2026-10-24T08:00:00Z"] = ([Self.item("old", "2026-10-15T08:00:00Z")], nil)
        api.starts = ["2026-10-26T08:00:00Z", "2026-10-24T08:00:00Z"]
        return (MealJournalViewModel(patientID: "p", api: api, calendar: calendar, now: { now }), api, calendar)
    }

    func testListsEveryDayWithTheDotsOfTheMonth() async {
        let (model, _, _) = model()
        await model.load()
        XCTAssertEqual(model.days.map { $0.items.map(\.meal_id) }, [["today"], ["sat"]])
        XCTAssertTrue(model.canLoadMore)
        XCTAssertEqual(model.marker(for: Self.iso.date(from: "2026-10-24T12:00:00Z")!), .entries)
        XCTAssertEqual(model.marker(for: Self.iso.date(from: "2026-10-25T12:00:00Z")!), .none)
        await model.loadMore()
        XCTAssertEqual(model.items.map(\.meal_id), ["today", "sat", "old"])
        XCTAssertFalse(model.canLoadMore)
    }

    func testATappedDayReadsOlderPagesAndScrollsThere() async {
        let (model, api, calendar) = model()
        await model.load()
        await model.select(Self.iso.date(from: "2026-10-15T12:00:00Z")!)
        XCTAssertEqual(api.pageQueries, [nil, "2026-10-24T08:00:00Z"])
        XCTAssertEqual(model.scrollRequest?.day, calendar.startOfDay(for: Self.iso.date(from: "2026-10-15T12:00:00Z")!))
        XCTAssertNil(model.dayNote)

        // A day without meals: the nearest earlier one, said for a moment.
        await model.select(Self.iso.date(from: "2026-10-25T12:00:00Z")!)
        XCTAssertEqual(model.scrollRequest?.day, calendar.startOfDay(for: Self.iso.date(from: "2026-10-24T12:00:00Z")!))
        XCTAssertEqual(model.dayNote, "Brak posiłków 25 października")
        XCTAssertEqual(model.selectedDay, calendar.startOfDay(for: Self.iso.date(from: "2026-10-25T12:00:00Z")!), "the tapped day stays marked")
    }

    func testATappedDayStopsWhenOlderPagesCannotBeRead() async {
        let (model, api, calendar) = model()
        await model.load()
        api.olderPagesFail = true
        await model.select(Self.iso.date(from: "2026-10-15T12:00:00Z")!)
        XCTAssertEqual(api.pageQueries, [nil, "2026-10-24T08:00:00Z"], "one try, not 30")
        XCTAssertEqual(model.scrollRequest?.day, calendar.startOfDay(for: Self.iso.date(from: "2026-10-24T12:00:00Z")!), "the oldest day read")
    }

    func testTwoCallersShareTheOlderPageOnItsWay() async {
        let (model, api, _) = model()
        await model.load()
        async let first = model.loadMore()
        async let second = model.loadMore()
        let added = await [first, second]
        XCTAssertEqual(added, [true, true])
        XCTAssertEqual(api.pageQueries, [nil, "2026-10-24T08:00:00Z"])
        let more = await model.loadMore()
        XCTAssertFalse(more)
    }

    func testAReminderErrorStaysAfterTheReloadItCauses() async {
        let (model, api, _) = model()
        await model.load()
        api.reminderError = APIClientError.conflict(nil)
        await model.setReminder(mealID: "today", reminderID: "wbt", enabled: false)
        XCTAssertEqual(model.errorMessage, "To przypomnienie już przyszło albo wygasło.")
        await model.load()
        XCTAssertNotNil(model.errorMessage, "a later reload keeps it until it is dismissed")

        let page = MealOverviewViewModel(patientID: "p", mealID: "m1", api: api)
        await page.setReminder(id: "wbt", enabled: false)
        XCTAssertEqual(page.errorMessage, "To przypomnienie już przyszło albo wygasło.")
        XCTAssertNotNil(page.overview)
        XCTAssertNil(page.loadErrorMessage)
    }

    func testASearchThatFailsIsNotNothingFound() async throws {
        let (model, api, _) = model()
        api.searchFails = true
        model.query = "pizza"
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertTrue(model.searchFailed)
        api.searchFails = false
        model.query = "pizz"
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertFalse(model.searchFailed)
        XCTAssertTrue(model.searchResults.isEmpty)
    }

    func testTheCalendarFollowsTheTopOfTheListAndTheArrowsKeepTheDay() async {
        let (model, _, calendar) = model()
        await model.load()
        let saturday = calendar.startOfDay(for: Self.iso.date(from: "2026-10-24T12:00:00Z")!)
        model.visibleDaysChanged([saturday])
        XCTAssertEqual(model.selectedDay, saturday)

        let chosen = model.selectedDay
        await model.showWeek(offset: -1)
        XCTAssertEqual(model.selectedDay, chosen)
        XCTAssertEqual(model.weekOfSelectedDay.first.map { calendar.component(.day, from: $0) }, 12)
        await model.showWeek(offset: 1)
        await model.showWeek(offset: 1)
        XCTAssertFalse(model.canShowNextWeek, "no week after this one")

        await model.select(Self.iso.date(from: "2026-10-27T12:00:00Z")!)
        XCTAssertEqual(model.selectedDay, saturday, "a future day is not chosen")
    }
}
