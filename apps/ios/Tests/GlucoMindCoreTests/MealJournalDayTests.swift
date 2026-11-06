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
        /// What "Scal" is told first; the merges asked for.
        var mergePreview = MealMergePreview(ok: true, meal_id: "today", content: MealMergePreview.Content.none, split: false)
        var merges: [(ids: [String], reset: Bool, split: MealMergeSplitChoice?)] = []
        var mergeError: Error?
        var deletes: [String] = []
        var deleteError: Error?
        func deleteMeal(patientID: String, mealID: String) async throws -> MealDeleteResponse {
            if let deleteError { throw deleteError }
            deletes.append(mealID)
            pages[nil] = (pages[nil]?.items.filter { !$0.contains(#""meal_id":"\#(mealID)""#) } ?? [], nil)
            return MealDeleteResponse(patient_id: "p", meal_id: mealID)
        }
        func previewMealMerge(patientID: String, mealIDs: [String]) async throws -> MealMergePreviewResponse {
            MealMergePreviewResponse(patient_id: "p", merge: mergePreview)
        }
        func mergeMeals(patientID: String, mealIDs: [String], resetConfirmed: Bool, split: MealMergeSplitChoice?) async throws -> MealMergeResponse {
            if let mergeError { throw mergeError }
            merges.append((mealIDs, resetConfirmed, split))
            let target = mergePreview.meal_id ?? mealIDs[0]
            // The merged meal on the first page only; the others are gone.
            pages[nil] = ([MealJournalDayTests.item(target, "2026-10-24T08:00:00Z", carbs: 55, insulin: 5.5)], nil)
            let json = #"{"patient_id":"p","meal_id":"\#(target)","item":\#(MealJournalDayTests.item(target, "2026-10-24T08:00:00Z", carbs: 55, insulin: 5.5))}"#
            return try JSONDecoder().decode(MealMergeResponse.self, from: Data(json.utf8))
        }
    }

    nonisolated fileprivate static func item(_ id: String, _ startedAt: String, carbs: Double = 10, insulin: Double = 1) -> String {
        #"{"meal_id":"\#(id)","started_at":"\#(startedAt)","title":null,"carbs_g":\#(carbs),"insulin_total_u":\#(insulin),"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[]}"#
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

    // MARK: "Scal"

    func testMergeTicksMealsAndMergesWithoutQuestionsWhenNothingIsLost() async {
        let (model, api, _) = model()
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("snack", "2026-10-26T07:15:00Z")], nil)
        await model.load()
        model.startSelecting()
        model.toggleSelection("today")
        XCTAssertFalse(model.canMergeSelection, "one meal is not a merge")
        model.toggleSelection("snack")
        XCTAssertTrue(model.canMergeSelection)
        await model.mergeSelected()
        XCTAssertNil(model.mergeQuestion)
        XCTAssertTrue(api.merges.isEmpty, "nothing is sent while the bar can still undo it")
        XCTAssertEqual(model.undoableChange?.title, "Scalono 2 posiłki")
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["today"], "shown merged at once")
        XCTAssertEqual(model.days.first?.items.first?.carbs_g, 20)
        await model.finishSending()
        XCTAssertEqual(api.merges.count, 1)
        XCTAssertEqual(api.merges[0].ids, ["today", "snack"])
        XCTAssertFalse(api.merges[0].reset)
        XCTAssertNil(api.merges[0].split)
        XCTAssertFalse(model.isSelecting)
        XCTAssertEqual(model.items.map(\.meal_id), ["today"], "the merged-away meal left the list")
        XCTAssertNil(model.mergeChatRequest)
        XCTAssertNil(model.undoableChange)
    }

    func testMergeAsksBeforeResettingThenAboutTheSplitAndOpensTheChat() async {
        let (model, api, _) = model()
        api.mergePreview = MealMergePreview(ok: true, meal_id: "snack", content: .reset, split: true)
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("snack", "2026-10-26T07:15:00Z")], nil)
        await model.load()
        model.startSelecting()
        model.toggleSelection("today")
        model.toggleSelection("snack")
        await model.mergeSelected()
        XCTAssertEqual(model.mergeQuestion, .confirmReset)
        XCTAssertTrue(api.merges.isEmpty, "nothing merged before the answer")
        await model.confirmMergeReset()
        XCTAssertEqual(model.mergeQuestion, .chooseSplit)
        XCTAssertTrue(api.merges.isEmpty)
        await model.chooseMergeSplit(.resplit)
        XCTAssertEqual(api.merges.count, 1)
        XCTAssertTrue(api.merges[0].reset)
        XCTAssertEqual(api.merges[0].split, .resplit)
        let text = model.mergeChatRequest?.text ?? ""
        XCTAssertTrue(text.hasPrefix("Posiłki z "), text)
        XCTAssertTrue(text.contains(" i ") && text.contains("zostały scalone w jeden posiłek"), text)
        XCTAssertTrue(text.contains("55 g węglowodanów"), text)
        XCTAssertTrue(text.contains("podano już 5,5 j insuliny"), text)
        XCTAssertNil(model.undoableChange, "the chat opens at once, with no bar")
    }

    func testAResetMergeKeepingTheSplitWaitsForItsBarAndNeedsADescription() async {
        let (model, api, _) = model()
        api.mergePreview = MealMergePreview(ok: true, meal_id: "snack", content: .reset, split: true)
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("snack", "2026-10-26T07:15:00Z")], nil)
        await model.load()
        model.startSelecting()
        model.toggleSelection("today")
        model.toggleSelection("snack")
        await model.mergeSelected()
        await model.confirmMergeReset()
        await model.chooseMergeSplit(.keep)
        XCTAssertTrue(api.merges.isEmpty)
        XCTAssertEqual(model.days.first?.items.first?.needsDescription, true, "the tile's \"Opisz\" chip asks for it")
        await model.finishSending()
        XCTAssertEqual(api.merges.first?.split, .keep)
        XCTAssertNil(model.mergeChatRequest)
    }

    // MARK: "Usuń" and "Cofnij"

    private func twoMeals() async -> (MealJournalViewModel, FakeAPI) {
        let (model, api, _) = model()
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("snack", "2026-10-26T07:15:00Z")], nil)
        await model.load()
        return (model, api)
    }

    func testDeleteShowsAtOnceAndIsSentOnlyWhenItsBarGoes() async {
        let (model, api) = await twoMeals()
        model.requestDelete("snack")
        XCTAssertTrue(api.deletes.isEmpty)
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["today"])
        XCTAssertEqual(model.undoableChange?.title, "Usunięto: Nowy posiłek")
        XCTAssertEqual(model.undoableChange?.isDelete, true)
        XCTAssertEqual(MealJournalViewModel.deleteNote(loop: LoopSystemKind.trio.names), "Posiłek usunięty jedynie z Mellis, dla Trio i pętli jest nadal widoczny.")
        XCTAssertEqual(MealJournalViewModel.deleteNote(loop: LoopSystemKind.loop.names), "Posiłek usunięty jedynie z Mellis, dla Loopa i pętli jest nadal widoczny.")
        XCTAssertEqual(MealJournalViewModel.deleteNote(loop: LoopSystemKind.unknown.names), "Posiłek usunięty jedynie z Mellis, dla pętli jest nadal widoczny.")
        await model.finishSending()
        XCTAssertEqual(api.deletes, ["snack"])
        XCTAssertNil(model.undoableChange)
        XCTAssertEqual(model.items.map(\.meal_id), ["today"])
    }

    func testUndoPutsTheMealBackAndSendsNothing() async {
        let (model, api) = await twoMeals()
        model.requestDelete("snack")
        model.undoChange()
        await model.finishSending()
        XCTAssertTrue(api.deletes.isEmpty)
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["today", "snack"])
        XCTAssertNil(model.undoableChange)
    }

    func testUndoOfAMergeSendsNothingAndBringsBothMealsBack() async {
        let (model, api) = await twoMeals()
        model.startSelecting()
        model.toggleSelection("today")
        model.toggleSelection("snack")
        await model.mergeSelected()
        model.undoChange()
        await model.finishSending()
        XCTAssertTrue(api.merges.isEmpty)
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["today", "snack"])
        XCTAssertNil(model.justMergedMealID)
    }

    func testAReloadDuringTheBarDoesNotBringTheMealBack() async {
        let (model, _) = await twoMeals()
        model.requestDelete("snack")
        await model.load()
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["today"])
    }

    func testTheTimeRunningOutSendsTheChange() async throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        let api = FakeAPI()
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z")], nil)
        let model = MealJournalViewModel(patientID: "p", api: api, calendar: calendar, undoSeconds: 0.05, now: { Self.iso.date(from: "2026-10-26T12:00:00Z")! })
        await model.load()
        model.requestDelete("today")
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(api.deletes, ["today"])
        XCTAssertNil(model.undoableChange)
    }

    func testANextChangeSendsThePreviousOneAndOnlyItCanBeUndone() async {
        let (model, api) = await twoMeals()
        model.requestDelete("snack")
        model.requestDelete("today")
        model.undoChange()
        await model.finishSending()
        XCTAssertEqual(api.deletes, ["snack"])
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["today"])
    }

    func testStartingToTickSendsTheChangeOnTheBar() async {
        let (model, api) = await twoMeals()
        model.requestDelete("snack")
        model.startSelecting(with: "today")
        XCTAssertNil(model.undoableChange)
        await model.finishSending()
        XCTAssertEqual(api.deletes, ["snack"])
    }

    func testARefusedDeleteBringsTheMealBackAndSaysWhy() async {
        let (model, api) = await twoMeals()
        api.deleteError = APIClientError.conflict(nil)
        model.requestDelete("snack")
        await model.finishSending()
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["today", "snack"])
        XCTAssertNotNil(model.errorMessage)
    }

    func testAMealWithADoseToComeIsAskedAbout() async throws {
        let (model, api, _) = model()
        let reminder = #"{"id":"part","kind":"PLANNED_PART","trigger":"AFTER_MINUTES","due_at":"2026-10-26T13:30:00Z","wait_until":null,"status":"WAITING","enabled":true}"#
        let planned = Self.item("split", "2026-10-26T11:00:00Z").replacingOccurrences(of: #""reminders":[]"#, with: #""reminders":[\#(reminder)]"#)
        api.pages[nil] = ([planned], nil)
        await model.load()
        model.requestDelete("split")
        XCTAssertNil(model.undoableChange)
        let text = try XCTUnwrap(model.deleteQuestion?.text)
        XCTAssertTrue(text.hasPrefix("Ten posiłek czeka na drugą część bolusa o "), text)
        model.cancelDelete()
        XCTAssertEqual(model.days.flatMap(\.items).map(\.meal_id), ["split"])
        model.requestDelete("split")
        model.confirmDelete()
        XCTAssertNotNil(model.undoableChange)
        await model.finishSending()
        XCTAssertEqual(api.deletes, ["split"])
    }

    func testARefusedMergeSaysWhyAndKeepsTheTicks() async {
        let (model, api, _) = model()
        api.mergePreview = MealMergePreview(ok: false, code: "MEAL_MERGE_SEVERAL_SPLIT", message: "Takich posiłków nie można scalić.")
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("snack", "2026-10-26T07:15:00Z")], nil)
        await model.load()
        model.startSelecting()
        model.toggleSelection("today")
        model.toggleSelection("snack")
        await model.mergeSelected()
        XCTAssertEqual(model.errorMessage, "Takich posiłków nie można scalić.")
        XCTAssertTrue(api.merges.isEmpty)
        XCTAssertTrue(model.isSelecting)
        XCTAssertEqual(model.selectedMealIDs, ["today", "snack"])
    }

    func testACancelledQuestionMergesNothing() async {
        let (model, api, _) = model()
        api.mergePreview = MealMergePreview(ok: true, meal_id: "snack", content: .reset, split: false)
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("snack", "2026-10-26T07:15:00Z")], nil)
        await model.load()
        model.startSelecting()
        model.toggleSelection("today")
        model.toggleSelection("snack")
        await model.mergeSelected()
        model.cancelMergeQuestion()
        await model.confirmMergeReset()
        XCTAssertTrue(api.merges.isEmpty)
        XCTAssertNil(model.mergeQuestion)
    }

    func testAConflictShowsTheServerWords() {
        let problem = ProblemDetails(type: "about:blank", title: "MEAL_MERGE_SENDING: Dla jednego z tych posiłków właśnie wysyłana jest dawka.", status: 409, code: "CONFLICT", instance: nil)
        XCTAssertEqual(MealJournalViewModel.mergeErrorText(APIClientError.conflict(problem)), "Dla jednego z tych posiłków właśnie wysyłana jest dawka.")
    }

    func testMealsOutsideTheFourHourWindowCannotBeTicked() async {
        let (model, api, _) = model()
        api.pages[nil] = ([
            Self.item("late", "2026-10-26T11:00:00Z"),
            Self.item("lunch", "2026-10-26T09:00:00Z"),
            Self.item("early", "2026-10-26T07:00:00Z"),
            Self.item("dawn", "2026-10-26T06:59:00Z"),
        ], nil)
        await model.load()
        model.startSelecting()
        XCTAssertTrue(model.items.allSatisfy { model.canSelect($0) }, "nothing ticked: any meal can start")
        XCTAssertFalse(model.hasMealsOutsideMergeWindow)
        model.toggleSelection("lunch")
        XCTAssertTrue(model.items.allSatisfy { model.canSelect($0) }, "all within 4 h of 09:00")
        model.toggleSelection("late")
        let selectable = model.items.filter { model.canSelect($0) }.map(\.meal_id)
        XCTAssertEqual(selectable, ["late", "lunch", "early"], "07:00 to 11:00 is exactly 4 h; 06:59 is not")
        XCTAssertTrue(model.hasMealsOutsideMergeWindow)
        model.toggleSelection("dawn")
        XCTAssertEqual(model.selectedMealIDs, ["lunch", "late"], "a greyed-out meal is not ticked")
        model.toggleSelection("late")
        XCTAssertTrue(model.canSelect(model.items.first { $0.meal_id == "dawn" }!), "unticking widens the window again")
    }

    func testHoldingAMealStartsMergeWithItTicked() async {
        let (model, api, _) = model()
        api.pages[nil] = ([Self.item("today", "2026-10-26T08:00:00Z"), Self.item("snack", "2026-10-26T07:15:00Z")], nil)
        await model.load()
        model.startSelecting(with: "snack")
        XCTAssertTrue(model.isSelecting)
        XCTAssertEqual(model.selectedMealIDs, ["snack"])
        model.startSelecting(with: "today")
        XCTAssertEqual(model.selectedMealIDs, ["snack", "today"], "a hold while ticking ticks, never unticks")
        model.startSelecting(with: "today")
        XCTAssertEqual(model.selectedMealIDs, ["snack", "today"])
    }

    func testMealPlurals() {
        XCTAssertEqual(MealMergeText.selectionLine(2), "Zaznaczono 2 posiłki.")
        XCTAssertEqual(MealMergeText.selectionLine(5), "Zaznaczono 5 posiłków.")
        XCTAssertEqual(MealMergeText.selectionLine(22), "Zaznaczono 22 posiłki.")
        XCTAssertEqual(MealMergeText.selectionLine(12), "Zaznaczono 12 posiłków.")
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
