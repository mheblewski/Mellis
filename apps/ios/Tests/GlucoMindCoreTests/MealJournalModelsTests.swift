import XCTest
@testable import GlucoMindCore

final class MealJournalModelsTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    func testABolusTabMealIsNamedByItsCarbsAndInsulin() throws {
        let json = #"{"meal_id":"m1","started_at":"2026-10-25T18:05:00.000Z","title":null,"carbs_g":45,"insulin_total_u":4.5,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"2026-10-25T20:35:00.000Z","wait_until":null,"status":"WAITING","enabled":true,"fired_at":null},{"id":"r2","kind":"SECOND_DOSE","trigger":"AFTER_MINUTES","due_at":"2026-10-25T18:35:00.000Z","wait_until":null,"status":"WAITING","enabled":true,"fired_at":null}]}"#
        let item = try JSONDecoder().decode(MealJournalItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.displayTitle, "Nowy posiłek")
        XCTAssertEqual(item.subtitle(timeZone: utc), "18:05 · zakładka Bolus · 2 przypomnienia")
    }

    func testAChatMealShowsItsDescriptionAndTotal() throws {
        let json = #"{"meal_id":"m2","started_at":"2026-10-25T13:10:00.000Z","title":"Pizza margherita","carbs_g":60,"insulin_total_u":7.2,"source":"CHAT","conversation_id":"c1","has_macros":true,"reminders":[],"glucose_peak_mgdl":212,"glucose_min_mgdl":118}"#
        let item = try JSONDecoder().decode(MealJournalItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.displayTitle, "Pizza margherita")
        XCTAssertEqual(item.subtitle(timeZone: utc), "13:10 · 60 g · 7,2 j razem · z czatu")
        XCTAssertEqual(item.glucoseRange, "szczyt 212 · najniżej 118")
    }

    func testAnExpiredRisingReminderSaysItDidNotRise() throws {
        let json = #"{"id":"r","kind":"SECOND_DOSE","trigger":"GLUCOSE_RISING","due_at":"2026-10-25T13:20:00.000Z","wait_until":"2026-10-25T14:20:00.000Z","status":"EXPIRED","enabled":true,"fired_at":null}"#
        let reminder = try JSONDecoder().decode(MealJournalReminder.self, from: Data(json.utf8))
        XCTAssertEqual(reminder.title, "Druga dawka, gdy zacznie rosnąć")
        XCTAssertFalse(reminder.isPending)
        let step = MealJournalTimeline.steps(item: try item(reminders: json), loopSystem: .trio, timeZone: utc).last
        XCTAssertEqual(step?.note, "glukoza nie wzrosła w ciągu 1 h")
    }

    private func item(reminders: String, source: String = "BOLUS_SCREEN") throws -> MealJournalItem {
        let json = #"{"meal_id":"m1","started_at":"2026-10-25T18:05:00.000Z","title":null,"carbs_g":45,"insulin_total_u":4.5,"source":"\#(source)","conversation_id":null,"has_macros":false,"reminders":[\#(reminders)]}"#
        return try JSONDecoder().decode(MealJournalItem.self, from: Data(json.utf8))
    }

    /// A kind, a state or a source added on the server later must not make the whole page unreadable.
    func testAReminderOrSourceThisBuildDoesNotKnowStillDecodes() throws {
        let reminder = #"{"id":"r9","kind":"SNACK_CHECK","trigger":null,"due_at":"2026-10-25T18:35:00.000Z","wait_until":null,"status":"SNOOZED","enabled":true,"fired_at":null}"#
        let meal = try item(reminders: reminder, source: "WATCH")
        XCTAssertEqual(meal.source, .other)
        XCTAssertEqual(meal.reminders.first?.kind, .unknown)
        XCTAssertEqual(meal.reminders.first?.status, .unknown)
        XCTAssertEqual(meal.reminders.first?.title, "Przypomnienie")
        let step = MealJournalTimeline.steps(item: meal, loopSystem: .trio, timeZone: utc).last
        XCTAssertNil(step?.action, "nothing to switch on a state it does not know")
        XCTAssertFalse(MealWbtReminderState(reminder: meal.reminders.first, mealStart: meal.startedDate, now: Date()).canSwitch)
    }

    func testTheOverviewSaysWhatWasGivenSinceTheMeal() throws {
        let json = #"{"patient_id":"p","overview":{"meal_id":"m1","started_at":"2026-10-25T17:05:00.000Z","title":null,"carbs_g":45,"insulin_total_u":4.5,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[],"description":null,"glucose":[],"boluses":[],"timeline":[],"given_since_start":{"since":"2026-10-25T17:05:00.000Z","total_u":1.2,"doses":[{"at":"2026-10-25T17:20:00.000Z","insulin_u":1.2,"by":"Ewa"}],"line":"⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa)."}}}"#
        let overview = try JSONDecoder().decode(MealOverviewResponse.self, from: Data(json.utf8)).overview
        XCTAssertEqual(overview.given_since_start?.anyGiven, true)
        XCTAssertEqual(overview.given_since_start?.line, "⚠️ Od 18:05 podano już 1,2 j (18:20, Ewa).")
    }

    func testTheOverviewReadsBolusesOnNoMealAndAnOlderServerWithout() throws {
        let json = #"{"patient_id":"p","overview":{"meal_id":"m1","started_at":"2026-10-25T17:05:00.000Z","title":null,"carbs_g":45,"insulin_total_u":4.5,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[],"description":null,"glucose":[],"boluses":[],"other_boluses":[{"at":"2026-10-25T17:40:00.000Z","insulin_u":1.5,"carbs_g":null,"kind":"OTHER","source":"GLUCOMIND","author_name":"Ewa"}],"timeline":[]}}"#
        let overview = try JSONDecoder().decode(MealOverviewResponse.self, from: Data(json.utf8)).overview
        XCTAssertEqual(overview.other_boluses.map(\.insulin_u), [1.5])
        let older = json.replacingOccurrences(of: #","other_boluses":[{"at":"2026-10-25T17:40:00.000Z","insulin_u":1.5,"carbs_g":null,"kind":"OTHER","source":"GLUCOMIND","author_name":"Ewa"}]"#, with: "")
        XCTAssertEqual(try JSONDecoder().decode(MealOverviewResponse.self, from: Data(older.utf8)).overview.other_boluses, [])
    }

    /// A server answer of this shape for a Bolus tab meal (synthetic values): it showed "Nie udało się wczytać posiłku".
    func testDecodesTheServersOverviewOfABolusTabMeal() throws {
        let json = #"{"patient_id":"aaaaaaaa-0000-4000-8000-000000000001","overview":{"meal_id":"aaaaaaaa-0000-4000-8000-000000000002","started_at":"2026-09-16T07:53:01.893Z","title":null,"carbs_g":20,"insulin_total_u":null,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[{"id":"aaaaaaaa-0000-4000-8000-000000000003","kind":"SECOND_DOSE","trigger":"GLUCOSE_RISING","due_at":"2026-09-16T07:53:07.291Z","wait_until":"2026-09-16T08:53:00.816Z","status":"WAITING","enabled":true,"fired_at":null}],"description":null,"status":"AWAITING_DESCRIPTION","trusted":false,"content_revision":1,"macros":{"carbs":{"grams":null,"origin":null},"protein":{"grams":null,"origin":null},"fat":{"grams":null,"origin":null}},"items":null,"has_photo":false,"pending_proposal_id":null,"glucose":[{"observed_at":"2026-09-16T07:25:12.279Z","glucose_mgdl":120},{"observed_at":"2026-09-16T07:30:12.279Z","glucose_mgdl":116},{"observed_at":"2026-09-16T07:35:12.279Z","glucose_mgdl":116},{"observed_at":"2026-09-16T07:40:12.279Z","glucose_mgdl":109},{"observed_at":"2026-09-16T07:45:12.279Z","glucose_mgdl":104},{"observed_at":"2026-09-16T07:50:12.279Z","glucose_mgdl":103}],"boluses":[{"at":"2026-09-16T07:53:01.893Z","insulin_u":null,"carbs_g":20,"kind":"MEAL","source":"GLUCOMIND","author_name":"Opiekun testowy"}],"timeline":[{"at":"2026-09-16T07:53:01.893Z","type":"BOLUS","bolus":{"at":"2026-09-16T07:53:01.893Z","insulin_u":null,"carbs_g":20,"kind":"MEAL","source":"GLUCOMIND","author_name":"Opiekun testowy"}},{"at":"2026-09-16T07:53:07.291Z","type":"REMINDER","reminder":{"id":"aaaaaaaa-0000-4000-8000-000000000003","kind":"SECOND_DOSE","trigger":"GLUCOSE_RISING","due_at":"2026-09-16T07:53:07.291Z","wait_until":"2026-09-16T08:53:00.816Z","status":"WAITING","enabled":true,"fired_at":null}}],"given_since_start":{"since":"2026-09-16T07:53:01.893Z","total_u":0,"doses":[],"line":"Od 08:53 nie podano insuliny."}}}"#
        let overview = try JSONDecoder().decode(MealOverviewResponse.self, from: Data(json.utf8)).overview
        XCTAssertEqual(overview.item.displayTitle, "Nowy posiłek")
        XCTAssertFalse(overview.glucose.isEmpty)
        XCTAssertEqual(overview.item.reminders.first?.kind, .secondDose)
        XCTAssertEqual(overview.given_since_start?.anyGiven, false)
    }

    /// Server answers of this shape for the list and the search (synthetic values).
    func testDecodesTheServersListAndSearch() throws {
        let list = try JSONDecoder().decode(MealJournalResponse.self, from: Data(#"{"patient_id":"aaaaaaaa-0000-4000-8000-000000000001","items":[{"meal_id":"aaaaaaaa-0000-4000-8000-000000000002","started_at":"2026-09-16T07:53:01.893Z","title":null,"carbs_g":20,"insulin_total_u":null,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[{"id":"aaaaaaaa-0000-4000-8000-000000000003","kind":"SECOND_DOSE","trigger":"GLUCOSE_RISING","due_at":"2026-09-16T07:53:07.291Z","wait_until":"2026-09-16T08:53:00.816Z","status":"WAITING","enabled":true,"fired_at":null}]},{"meal_id":"aaaaaaaa-0000-4000-8000-000000000004","started_at":"2026-09-13T05:57:44.403Z","title":"Kanapka z serem","carbs_g":15,"insulin_total_u":1.5,"source":"OTHER","conversation_id":null,"has_macros":true,"reminders":[]},{"meal_id":"aaaaaaaa-0000-4000-8000-000000000005","started_at":"2026-09-12T10:33:37.219Z","title":"Frytki i kurczak","carbs_g":40,"insulin_total_u":3,"source":"CHAT","conversation_id":"aaaaaaaa-0000-4000-8000-000000000006","has_macros":true,"reminders":[{"id":"aaaaaaaa-0000-4000-8000-000000000007","kind":"PLANNED_PART","trigger":"AFTER_MINUTES","due_at":"2026-09-12T10:43:37.219Z","wait_until":null,"status":"GIVEN","enabled":true,"fired_at":"2026-09-12T10:43:47.466Z"},{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"2026-09-12T13:03:37.219Z","wait_until":null,"status":"SENT","enabled":true,"fired_at":"2026-09-12T13:04:23.279Z"}]},{"meal_id":"aaaaaaaa-0000-4000-8000-000000000008","started_at":"2026-09-10T08:55:05.259Z","title":"Makaron z sosem","carbs_g":38,"insulin_total_u":4,"source":"CHAT","conversation_id":"aaaaaaaa-0000-4000-8000-000000000009","has_macros":true,"reminders":[{"id":"aaaaaaaa-0000-4000-8000-000000000010","kind":"PLANNED_PART","trigger":"AFTER_MINUTES","due_at":"2026-09-10T09:55:05.259Z","wait_until":null,"status":"GIVEN","enabled":true,"fired_at":"2026-09-10T09:55:33.783Z"},{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"2026-09-10T11:25:05.259Z","wait_until":null,"status":"SENT","enabled":true,"fired_at":"2026-09-10T11:25:55.152Z"}]},{"meal_id":"aaaaaaaa-0000-4000-8000-000000000011","started_at":"2026-09-10T08:38:35.094Z","title":"Kurczak z frytkami","carbs_g":32,"insulin_total_u":3.2,"source":"CHAT","conversation_id":"aaaaaaaa-0000-4000-8000-000000000012","has_macros":true,"reminders":[{"id":"aaaaaaaa-0000-4000-8000-000000000013","kind":"PLANNED_PART","trigger":"AFTER_MINUTES","due_at":"2026-09-10T09:38:35.094Z","wait_until":null,"status":"GIVEN","enabled":true,"fired_at":"2026-09-10T09:39:03.776Z"},{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"2026-09-10T11:08:35.094Z","wait_until":null,"status":"SENT","enabled":true,"fired_at":"2026-09-10T11:08:55.127Z"}]}],"next_before":"2026-09-10T08:38:35.094Z"}"#.utf8))
        XCTAssertFalse(list.items.isEmpty)
        _ = try JSONDecoder().decode(MealSearchResponse.self, from: Data(#"{"patient_id":"aaaaaaaa-0000-4000-8000-000000000001","query":"frytki","items":[{"meal_id":"aaaaaaaa-0000-4000-8000-000000000005","started_at":"2026-09-12T10:33:37.219Z","title":"Frytki i kurczak","carbs_g":40,"insulin_total_u":3,"source":"CHAT","conversation_id":"aaaaaaaa-0000-4000-8000-000000000006","has_macros":true,"reminders":[{"id":"aaaaaaaa-0000-4000-8000-000000000007","kind":"PLANNED_PART","trigger":"AFTER_MINUTES","due_at":"2026-09-12T10:43:37.219Z","wait_until":null,"status":"GIVEN","enabled":true,"fired_at":"2026-09-12T10:43:47.466Z"},{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"2026-09-12T13:03:37.219Z","wait_until":null,"status":"SENT","enabled":true,"fired_at":"2026-09-12T13:04:23.279Z"}],"glucose_peak_mgdl":168,"glucose_min_mgdl":96},{"meal_id":"aaaaaaaa-0000-4000-8000-000000000014","started_at":"2026-09-09T18:55:18.818Z","title":"Frytki z ketchupem","carbs_g":25,"insulin_total_u":2.5,"source":"CHAT","conversation_id":"aaaaaaaa-0000-4000-8000-000000000015","has_macros":true,"reminders":[],"glucose_peak_mgdl":172,"glucose_min_mgdl":118},{"meal_id":"aaaaaaaa-0000-4000-8000-000000000016","started_at":"2026-09-09T14:49:14.341Z","title":"Frytki z ketchupem","carbs_g":25,"insulin_total_u":2.8,"source":"CHAT","conversation_id":"aaaaaaaa-0000-4000-8000-000000000017","has_macros":true,"reminders":[],"glucose_peak_mgdl":204,"glucose_min_mgdl":72}]}"#.utf8))
    }

    func testATimelineCallsCarbsAloneAnEntryAndSaysWhenARisingReminderComes() throws {
        let item = try JSONDecoder().decode(MealJournalItem.self, from: Data(#"{"meal_id":"m","started_at":"2026-10-26T08:10:01.893Z","title":null,"carbs_g":10,"insulin_total_u":null,"source":"BOLUS_SCREEN","conversation_id":null,"has_macros":false,"reminders":[{"id":"r","kind":"SECOND_DOSE","trigger":"GLUCOSE_RISING","due_at":"2026-10-26T08:10:07.291Z","wait_until":"2026-10-26T09:10:00.816Z","status":"WAITING","enabled":true,"fired_at":null}]}"#.utf8))
        let bolus = try JSONDecoder().decode(MealOverview.Bolus.self, from: Data(#"{"at":"2026-10-26T08:10:01.893Z","insulin_u":null,"carbs_g":10,"kind":"MEAL","source":"GLUCOMIND","author_name":"Opiekun testowy"}"#.utf8))
        let steps = MealJournalTimeline.steps(item: item, boluses: [bolus], loopSystem: .trio, now: ServerDate.parse("2026-10-26T08:20:00.000Z")!, timeZone: utc)
        XCTAssertEqual(steps.map(\.detail), ["Wpis 10 g do Trio", "Druga dawka"])
        // The patient's loop names the entry and a dose entered in it.
        let inLoop = try JSONDecoder().decode(MealOverview.Bolus.self, from: Data(#"{"at":"2026-10-26T08:10:01.893Z","insulin_u":null,"carbs_g":10,"kind":"MEAL","source":"LOOP","author_name":null}"#.utf8))
        let loopSteps = MealJournalTimeline.steps(item: item, boluses: [inLoop], loopSystem: .loop, now: ServerDate.parse("2026-10-26T08:20:00.000Z")!, timeZone: utc)
        XCTAssertEqual(loopSteps.first?.detail, "Wpis 10 g do Loopa")
        XCTAssertEqual(loopSteps.first?.note, "Loop")
        XCTAssertEqual(steps[1].time, "gdy rośnie")
        XCTAssertEqual(steps[1].note, "przypomnienie, gdy glukoza zacznie rosnąć, do 09:10")
        XCTAssertEqual(steps[1].actionTitle, "Wyłącz")
        XCTAssertTrue(MealJournalTimeline.isOpen(item))
    }
}
