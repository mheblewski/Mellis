import XCTest
@testable import GlucoMindCore

final class MealPageTests: XCTestCase {
    private let start = "2026-10-25T17:00:00.000Z"
    private var startDate: Date { ServerDate.parse(start)! }

    private func overview(reminders: String = "", hasMacros: Bool = true, description: String = "\"Burger z frytkami\"", shortName: String = "null", glucose: String = "", boluses: String = "") throws -> MealOverview {
        let json = #"{"patient_id":"p","overview":{"meal_id":"m1","started_at":"\#(start)","title":\#(description),"carbs_g":60,"insulin_total_u":3.6,"source":"CHAT","conversation_id":null,"has_macros":\#(hasMacros),"reminders":[\#(reminders)],"short_name":\#(shortName),"description":\#(description),"glucose":[\#(glucose)],"boluses":[\#(boluses)]}}"#
        return try JSONDecoder().decode(MealOverviewResponse.self, from: Data(json.utf8)).overview
    }

    private func reminder(_ id: String, _ kind: String, _ status: String, due: String = "2026-10-25T19:30:00.000Z", trigger: String = "AFTER_MINUTES", waitUntil: String = "null") -> String {
        #"{"id":"\#(id)","kind":"\#(kind)","trigger":"\#(trigger)","due_at":"\#(due)","wait_until":\#(waitUntil),"status":"\#(status)","enabled":true,"fired_at":null}"#
    }

    private func rows(_ overview: MealOverview, minutesAfter: Double = 30) -> [MealPageRow] {
        MealPageProgress.rows(overview, loopSystem: .trio, now: startDate.addingTimeInterval(minutesAfter * 60), timeZone: TimeZone(identifier: "Europe/Warsaw")!)
    }

    func testTitleIsTheShortNameAndTheDescriptionGoesBelow() throws {
        let named = try overview(shortName: "\"Burger\"")
        XCTAssertEqual(named.pageTitle, "Burger")
        XCTAssertEqual(named.descriptionLine, "Burger z frytkami")
    }

    func testTheDescriptionIsNotRepeatedUnderTheSameTitle() throws {
        let plain = try overview()
        XCTAssertEqual(plain.pageTitle, "Burger z frytkami")
        XCTAssertNil(plain.descriptionLine)
    }

    func testLowestGlucoseIgnoresReadingsBeforeTheMeal() throws {
        let page = try overview(glucose: #"{"observed_at":"2026-10-25T16:50:00.000Z","glucose_mgdl":60},{"observed_at":"2026-10-25T17:30:00.000Z","glucose_mgdl":90},{"observed_at":"2026-10-25T18:00:00.000Z","glucose_mgdl":150}"#)
        XCTAssertEqual(page.lowestGlucose, 90)
        XCTAssertEqual(page.peakGlucose, 150)
    }

    func testWbtIsOneRowWithItsSwitchAndDose() throws {
        let wbt = try XCTUnwrap(rows(try overview(reminders: reminder("wbt", "WBT", "WAITING"))).first { $0.id == "wbt" })
        XCTAssertEqual(wbt.switchReminderID, "wbt")
        XCTAssertTrue(wbt.isOn)
        XCTAssertTrue(wbt.offersWbtDose)
        XCTAssertEqual(wbt.note, "Przypomnę o 20:30, 2,5 h po posiłku.")
    }

    func testAnUndescribedMealSaysWhenWbtCanBeWorkedOut() throws {
        let wbt = try XCTUnwrap(rows(try overview(reminders: reminder("wbt", "WBT", "WAITING"), hasMacros: false, description: "null")).first { $0.id == "wbt" })
        XCTAssertFalse(wbt.offersWbtDose)
        XCTAssertEqual(wbt.note, "Przypomnę o 20:30, 2,5 h po posiłku. Dawkę policzę, gdy opiszesz posiłek.")
    }

    func testAGivenWbtIsOnlyItsBolus() throws {
        let list = rows(try overview(reminders: reminder("wbt", "WBT", "GIVEN"), boluses: #"{"at":"2026-10-25T19:30:00.000Z","insulin_u":1.5,"carbs_g":null,"kind":"WBT","source":"GLUCOMIND","author_name":"Ania"}"#), minutesAfter: 200)
        XCTAssertEqual(list.map(\.title), ["WBT 1,5 j"])
    }

    func testAWaitingPlannedPartOpensItsCardInsteadOfASwitch() throws {
        let part = try XCTUnwrap(rows(try overview(reminders: reminder("p1", "PLANNED_PART", "WAITING"))).first { $0.id == "reminder-p1" })
        XCTAssertEqual(part.plannedPartID, "p1")
        XCTAssertNil(part.switchReminderID)
    }

    func testASecondDoseWaitingForGlucoseSaysSoAndCanBeSwitched() throws {
        let row = try XCTUnwrap(rows(try overview(reminders: reminder("s1", "SECOND_DOSE", "WAITING", trigger: "GLUCOSE_RISING", waitUntil: "\"2026-10-25T18:30:00.000Z\""))).first { $0.id == "reminder-s1" })
        XCTAssertEqual(row.switchReminderID, "s1")
        XCTAssertEqual(row.note, "Przypomnę, gdy glukoza zacznie rosnąć, do 19:30")
    }

    func testCardLineDropsTheEmojiAndAsksToCheck() throws {
        let json = #"{"since":"2026-10-25T17:00:00.000Z","total_u":1.2,"doses":[{"at":"2026-10-25T17:20:00.000Z","insulin_u":1.2,"by":"Ania"}],"line":"⚠️ Od 18:00 podano już 1,2 j (18:20, Ania)."}"#
        let given = try JSONDecoder().decode(MealOverview.GivenSince.self, from: Data(json.utf8))
        XCTAssertEqual(given.cardLine, "Od 18:00 podano już 1,2 j (18:20, Ania). Sprawdź, zanim podasz.")
    }

    func testChartWindowFollowsWhatIsStillToCome() {
        let at = { (minutes: Double) in self.startDate.addingTimeInterval(minutes * 60) }
        XCTAssertEqual(MealOverviewChart.window(start: startDate, pending: [], now: at(10)).upperBound, at(120))
        XCTAssertEqual(MealOverviewChart.window(start: startDate, pending: [at(150)], now: at(10)).upperBound, at(180))
        XCTAssertEqual(MealOverviewChart.window(start: startDate, pending: [], now: at(1000)).upperBound, at(360))
        XCTAssertEqual(MealOverviewChart.window(start: startDate, pending: [], now: at(10)).lowerBound, at(-30))
    }

    func testEnergySharesWeighFatMore() {
        let shares = MealMacroSummary.energyShares(carbs: 60, protein: 32, fat: 44)
        XCTAssertEqual(shares.map(\.kind), [.carbs, .protein, .fat])
        XCTAssertEqual(shares[2].value, 396.0 / 764.0, accuracy: 0.001)
        XCTAssertTrue(MealMacroSummary.energyShares(carbs: 60, protein: nil, fat: nil).isEmpty)
    }
}

final class MealPartActionTests: XCTestCase {
    private func plan(status: String = "NOTIFIED", sending: Bool = false, command: String? = nil, sentByMe: Bool = true) throws -> PlannedBolusDetail {
        let commandJSON = command.map { #"{"id":"c1","status":"\#($0)","carbs_g":24,"insulin_u":2.0,"sent_by_me":\#(sentByMe),"retry_until":"2030-01-01T00:00:00.000Z"}"# } ?? "null"
        let json = #"{"id":"p1","status":"\#(status)","due_at":"2026-11-05T13:00:00.000Z","delay_minutes":60,"now_percent":60,"carbs_g":24,"planned_insulin_u":2.0,"first_carbs_g":36,"first_insulin_u":3.6,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":\#(sending),"meal_started_at":null,"estimate":null,"command":\#(commandJSON)}"#
        return try JSONDecoder().decode(PlannedBolusDetail.self, from: Data(json.utf8))
    }

    func testAnOpenPartOffersItsDose() throws {
        XCTAssertEqual(MealPartAction.of(try plan()), .give(doseU: 2.0))
    }

    func testNoDoseIsOfferedWhileACommandIsOnItsWay() throws {
        for status in ["AUTHORIZED", "SENT", "TRIO_ACCEPTED"] {
            XCTAssertEqual(MealPartAction.of(try plan(sending: true, command: status, sentByMe: false)), .waiting(insulinU: 2.0, sentByMe: false))
        }
        XCTAssertEqual(MealPartAction.of(try plan(sending: true)), .waiting(insulinU: nil, sentByMe: nil), "the other caregiver's, not read yet")
    }

    func testAnUnansweredCommandNeverOffersTheDoseAgain() throws {
        XCTAssertEqual(MealPartAction.of(try plan(command: "NO_REPLY")), .noReply)
    }

    func testRefusedAndPartialAreSaidAsSuch() throws {
        XCTAssertEqual(MealPartAction.of(try plan(command: "PARTIAL")), .carbsOnly(carbsG: 24))
        XCTAssertEqual(MealPartAction.of(try plan(command: "REJECTED")), .refused)
    }

    func testAFailedSendOffersTheDoseAgain() throws {
        XCTAssertEqual(MealPartAction.of(try plan(command: "SEND_FAILED")), .give(doseU: 2.0))
        XCTAssertEqual(MealPartAction.of(try plan(command: "EXPIRED")), .give(doseU: 2.0))
    }

    func testAClosedPartAsksForNothing() throws {
        XCTAssertEqual(MealPartAction.of(try plan(status: "SKIPPED")), .closed)
        XCTAssertEqual(MealPartAction.of(try plan(status: "GIVEN")), .given(insulinU: nil, by: nil, at: nil))
    }

    func testTheChatOnThePageFoldsAllButTheLastTwoMessages() {
        XCTAssertEqual(MealChatThread.firstShown(count: 5, folds: true), 3)
        XCTAssertEqual(MealChatThread.firstShown(count: 2, folds: true), 0)
        XCTAssertEqual(MealChatThread.firstShown(count: 5, folds: false), 0)
    }
}

final class MealPlanTests: XCTestCase {
    private func entry(plannedIn seconds: TimeInterval, now: Date, status: String = "PLANNED", items: [MealPlanItem] = [MealPlanItem(name: "Ziemniaki", carbs_g: 26), MealPlanItem(name: "Buraczki", carbs_g: 7)]) -> MealPlanEntry {
        let formatter = ISO8601DateFormatter()
        return MealPlanEntry(id: "e1", plan_id: "p1", kind: "MEAL", title: "Obiad", planned_at: formatter.string(from: now.addingTimeInterval(seconds)), items: items, status: status)
    }

    func testTheDoseIsOfferedOnlyNearTheMeal() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        guard case .tooEarly = MealPlanMoment.of(entry(plannedIn: 31 * 60, now: now), now: now) else { return XCTFail("too early") }
        XCTAssertEqual(MealPlanMoment.of(entry(plannedIn: 29 * 60, now: now), now: now), .soon)
        XCTAssertEqual(MealPlanMoment.of(entry(plannedIn: -60, now: now), now: now), .late)
        XCTAssertEqual(MealPlanMoment.of(entry(plannedIn: -31 * 60, now: now), now: now), .tooLate)
        XCTAssertEqual(MealPlanMoment.of(entry(plannedIn: 60, now: now, status: "SKIPPED"), now: now), .skipped)
    }

    func testAPortionChangesTheGramsCounted() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let meal = entry(plannedIn: 60, now: now)
        let potatoes = meal.items[0]
        let beets = meal.items[1]
        var plate = MealPlanPlate()
        XCTAssertEqual(plate.carbs(of: meal), 33)
        XCTAssertFalse(plate.isEdited)
        plate.set(.init(portion: .half), for: potatoes)
        XCTAssertEqual(plate.carbs(of: potatoes), 13)
        XCTAssertEqual(plate.carbs(of: meal), 20)
        plate.set(.init(portion: .none), for: beets)
        XCTAssertEqual(plate.carbs(of: meal), 13)
        plate.set(.init(portion: .grams(5.5), replacedBy: "Jabłko"), for: beets)
        XCTAssertEqual(plate.carbs(of: meal), 19)
        XCTAssertEqual(plate.described(meal), "Ziemniaki (połowa) 13 g, Jabłko zamiast: Buraczki 5,5 g")
        plate.set(.init(portion: .none), for: potatoes)
        plate.set(.init(portion: .none), for: beets)
        XCTAssertEqual(plate.carbs(of: meal), 0, "nothing eaten is zero grams, not an unknown meal")
        plate.set(.init(), for: potatoes)
        plate.set(.init(), for: beets)
        XCTAssertFalse(plate.isEdited, "back to the menu leaves no change")
    }

    func testAReplacedFoodWithoutGramsGivesNoDose() {
        let meal = entry(plannedIn: 60, now: Date(timeIntervalSince1970: 1_800_000_000))
        var plate = MealPlanPlate()
        plate.set(.init(replacedBy: "Ryż"), for: meal.items[0])
        XCTAssertEqual(plate.foodWithoutGrams(in: meal), "Ryż")
        XCTAssertNil(plate.carbs(of: meal.items[0]))
        XCTAssertNil(plate.carbs(of: meal), "never a dose counted without the new food")
        plate.set(.init(portion: .grams(30), replacedBy: "Ryż"), for: meal.items[0])
        XCTAssertNil(plate.foodWithoutGrams(in: meal))
        XCTAssertEqual(plate.carbs(of: meal), 37)
    }

    func testGramsAreReadFromTheField() {
        XCTAssertEqual(MealPlanPlate.grams(from: "12,5"), 12.5)
        XCTAssertEqual(MealPlanPlate.grams(from: " 7 "), 7)
        XCTAssertNil(MealPlanPlate.grams(from: "dużo"))
        XCTAssertNil(MealPlanPlate.grams(from: "-1"))
        XCTAssertNil(MealPlanPlate.grams(from: "501"))
    }

    func testCarbsFollowTheMenu() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let meal = entry(plannedIn: 60, now: now)
        XCTAssertEqual(meal.carbs(), 33)
        XCTAssertNil(entry(plannedIn: 60, now: now, items: []).carbs(), "no menu: no number made up")
        XCTAssertEqual(meal.rowSubtitle, "Ziemniaki, Buraczki · około 33 g")
    }

    func testAMealPlanPushOpensThePlannedMeal() {
        let patient = "11111111-1111-4111-8111-111111111111"
        let entry = "66666666-6666-4666-8666-666666666661"
        let route = MealLinkParser.parsePushPayload(userInfo: ["gluco": ["type": "meal_plan", "patientId": patient, "routePath": "/patients/\(patient)/meal-plan/\(entry)"]])
        XCTAssertEqual(route?.mealPlanEntryID, entry)
        XCTAssertEqual(route?.patientID, patient)
    }

    func testThePinnedCardShowsTheNextMealFromAnHourBefore() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertNil(MealPlanPin.entry(in: [entry(plannedIn: 61 * 60, now: now)], now: now), "more than an hour away")
        XCTAssertNotNil(MealPlanPin.entry(in: [entry(plannedIn: 59 * 60, now: now)], now: now))
        XCTAssertNil(MealPlanPin.entry(in: [entry(plannedIn: -60, now: now)], now: now), "already started")
        XCTAssertNil(MealPlanPin.entry(in: [entry(plannedIn: 600, now: now, status: "SKIPPED")], now: now))
        let sooner = MealPlanEntry(id: "soon", plan_id: "p", kind: "MEAL", title: "Obiad", planned_at: ISO8601DateFormatter().string(from: now.addingTimeInterval(600)), items: [])
        XCTAssertEqual(MealPlanPin.entry(in: [entry(plannedIn: 1800, now: now), sooner], now: now)?.id, "soon")
        let movement = MealPlanEntry(id: "wf", plan_id: "p", kind: "MOVEMENT", title: "WF", planned_at: ISO8601DateFormatter().string(from: now.addingTimeInterval(600)), items: [])
        XCTAssertNil(MealPlanPin.entry(in: [movement], now: now), "only meals")
        XCTAssertEqual(MealPlanPin.timeLeft(to: entry(plannedIn: 20 * 60 + 5, now: now), now: now), "za 20 min")
    }

    func testAPlanCardReadsAndAFieldItDoesNotKnowStaysOut() throws {
        let json = #"{"id":"c1","status":"PROPOSED","summary":"Plan ma 2 posiłki na 1 dzień.","notes":["Dawkę policzę przed każdym posiłkiem."],"times_to_check":[{"kind":"MEAL","title":"Obiad","time":null}],"days":[{"date":"2026-11-09","label":"Poniedziałek, 9 listopada","entries":[{"kind":"MEAL","title":"Obiad","time":null,"items":[{"name":"Zupa","carbs_g":12,"fat_g":1}]}]}],"button_title":"Włącz 2 przypomnienia: Ania","accepted_line":null,"skipped_line":null,"nowe_pole":1}"#
        let card = try JSONDecoder().decode(ConversationMealPlanProposal.self, from: Data(json.utf8))
        XCTAssertTrue(card.isOpen)
        XCTAssertEqual(card.times_to_check.first?.time, nil)
        XCTAssertEqual(card.days.first?.entries.first?.items.first?.carbs_g, 12)
        // A card with nothing else still decodes, as replaced: the conversation never breaks on it.
        let bare = try JSONDecoder().decode(ConversationMealPlanProposal.self, from: Data(#"{"id":"c2"}"#.utf8))
        XCTAssertFalse(bare.isOpen)
    }

    func testAPlanInSettingsIsNamedByItsDays() {
        let entry = { (id: String, plan: String, at: String, status: String) in
            MealPlanEntry(id: id, plan_id: plan, kind: "MEAL", title: "Obiad", planned_at: at, items: [], status: status)
        }
        let plans = MealPlanSummary.of([
            entry("1", "a", "2026-11-09T11:30:00Z", "PLANNED"),
            entry("2", "a", "2026-11-13T11:30:00Z", "PLANNED"),
            entry("3", "b", "2026-11-20T11:30:00Z", "SKIPPED"),
        ])
        XCTAssertEqual(plans.map(\.id), ["a"])
        XCTAssertEqual(plans.first?.range, "9–13 listopada")
    }

    func testAMessageSaysThisPhoneShowsPlanCards() throws {
        let data = try JSONEncoder().encode(UserMessageSubmissionRequest(content: "x"))
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(#""meal_plan_cards":true"#))
    }

    func testAFoodCanBeAddedToAPlate() {
        let meal = entry(plannedIn: 60, now: Date(timeIntervalSince1970: 1_800_000_000))
        var plate = MealPlanPlate()
        plate.add(name: " Melon ", grams: 12)
        XCTAssertEqual(plate.carbs(of: meal), 45)
        XCTAssertTrue(plate.described(meal).hasSuffix("Melon 12 g"))
        plate.removeAdded(plate.added[0])
        XCTAssertFalse(plate.isEdited)
        plate.add(name: "  ", grams: 12)
        XCTAssertTrue(plate.added.isEmpty, "no food without a name")
        // A timetable without a menu: an added food is the first number.
        let noMenu = entry(plannedIn: 60, now: Date(timeIntervalSince1970: 1_800_000_000), items: [])
        XCTAssertNil(plate.carbs(of: noMenu))
        plate.add(name: "Kanapka", grams: 20)
        XCTAssertEqual(plate.carbs(of: noMenu), 20)
    }

    func testANoteFindsItsFoodAndOnlySuggests() {
        let note = PatientNote(id: "n", kind: "FOOD", text: "Zwykle zostaje na talerzu: Buraczki", food_name: "Buraczki", portion: "NONE", created_by_name: "Ewa")
        XCTAssertEqual(PatientNote.about(MealPlanItem(name: "buraczki na ciepło", carbs_g: 7), in: [note]), note)
        XCTAssertEqual(PatientNote.about(MealPlanItem(name: "Buraczki", carbs_g: 7), in: [note]), note)
        XCTAssertNil(PatientNote.about(MealPlanItem(name: "Ziemniaki", carbs_g: 26), in: [note]))
        let rule = PatientNote(id: "r", kind: "PLAN_RULE", text: "Buraczki są na wynos.")
        XCTAssertNil(PatientNote.about(MealPlanItem(name: "Buraczki", carbs_g: 7), in: [rule]), "a rule is not about a food on the page")
    }

    func testABolusNearAMealNeedsAnAnswerAndClosesThePin() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var meal = entry(plannedIn: 20, now: now)
        XCTAssertEqual(MealPlanDoseState.of(meal), .none)
        let given = MealPlanGiven(insulin_u: 4, at: "2026-11-10T11:00:00Z")
        meal.given = given
        XCTAssertEqual(MealPlanDoseState.of(meal), .asks(given))
        XCTAssertNil(MealPlanPin.entry(in: [meal], now: now), "a dose given near it: the meal is eaten, not planned")
        meal.dose_answer = "OTHER"
        XCTAssertEqual(MealPlanDoseState.of(meal), .forSomethingElse(given))
        XCTAssertNotNil(MealPlanPin.entry(in: [meal], now: now))
        meal.dose_answer = "THIS_MEAL"
        XCTAssertEqual(MealPlanDoseState.of(meal), .forThisMeal(given))
        XCTAssertNil(MealPlanPin.entry(in: [meal], now: now))
    }

    func testAMealBeforeAnActivityOffersASmallerDose() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let meal = entry(plannedIn: 60 * 60, now: now)
        func movement(_ minutes: Int, status: String = "PLANNED") -> MealPlanEntry {
            MealPlanEntry(id: "m\(minutes)", plan_id: "p", kind: "MOVEMENT", title: "WF", planned_at: ISO8601DateFormatter().string(from: now.addingTimeInterval(TimeInterval(minutes * 60))), items: [], status: status)
        }
        XCTAssertEqual(MealPlanMovementAhead.of(meal, in: [movement(135)]), MealPlanMovementAhead(title: "WF", minutes: 75))
        XCTAssertEqual(MealPlanMovementAhead.of(meal, in: [movement(135)])?.timeLabel, "1 h 15 min")
        XCTAssertEqual(MealPlanMovementAhead.of(meal, in: [movement(240)])?.minutes, 180, "exactly 3 hours still counts")
        XCTAssertNil(MealPlanMovementAhead.of(meal, in: [movement(241)]))
        XCTAssertNil(MealPlanMovementAhead.of(meal, in: [movement(30)]), "before the meal it says nothing")
        XCTAssertNil(MealPlanMovementAhead.of(meal, in: [movement(135, status: "SKIPPED")]))
        XCTAssertEqual(MealPlanMovementAhead.of(meal, in: [movement(200), movement(90)])?.minutes, 30, "the nearest one")
        XCTAssertEqual(MealPlanMovementAhead(title: "WF", minutes: 40).timeLabel, "40 min")
        XCTAssertEqual(MealPlanMovementAhead(title: "WF", minutes: 120).timeLabel, "2 h")
    }

    func testASmallerDoseRoundsDownToThePumpStep() {
        XCTAssertEqual(MealPlanMovementAhead.reduced(9.1), 6.8, accuracy: 0.001)
        XCTAssertEqual(MealPlanMovementAhead.reduced(4), 3, accuracy: 0.001)
        XCTAssertEqual(MealPlanMovementAhead.reduced(0.1), 0.05, accuracy: 0.001)
    }

    func testAnActivityRowSaysWhenItReminds() {
        let move = MealPlanEntry(id: "m", plan_id: "p", kind: "MOVEMENT", title: "WF", planned_at: "2026-11-10T13:45:00Z", items: [])
        XCTAssertEqual(move.rowSubtitle, "Przypomnę, jeśli cukier będzie niski")
        let skipped = MealPlanEntry(id: "m", plan_id: "p", kind: "MOVEMENT", title: "WF", planned_at: "2026-11-10T13:45:00Z", items: [], status: "SKIPPED")
        XCTAssertEqual(skipped.rowSubtitle, "Pominięte")
    }

    @MainActor
    func testAPlateSurvivesClosingTheApp() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "meal-plan-test-\(UUID().uuidString)"))
        let api = PlanListAPI(entries: [entry(plannedIn: 3_600, now: Date())])
        let first = MealPlanModel(patientID: "p", api: api, defaults: defaults)
        var plate = MealPlanPlate()
        plate.add(name: "Melon", grams: 12)
        plate.set(.init(portion: .half), for: MealPlanItem(name: "Ziemniaki", carbs_g: 26))
        plate.smallerBeforeMovement = true
        first.plates["e1"] = plate
        let second = MealPlanModel(patientID: "p", api: api, defaults: defaults)
        XCTAssertEqual(second.plates["e1"], plate)
        // A meal no longer in the plan takes its portions with it.
        second.plates["gone"] = plate
        await second.load()
        XCTAssertNil(second.plates["gone"])
        XCTAssertNotNil(second.plates["e1"])
    }

    func testTheCardCountsOnlyWhatCanStillRemind() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 18, minute: 47))!
        let json = #"""
        {"id":"c","days":[{"date":"2026-11-05","label":"Dziś","entries":[{"kind":"MEAL","title":"Śniadanie","time":null,"items":[]},{"kind":"MEAL","title":"Kolacja","time":"19:30","items":[]}]},{"date":"2026-11-06","label":"Jutro","entries":[{"kind":"MEAL","title":"Śniadanie","time":null,"items":[]},{"kind":"MOVEMENT","title":"WF","time":"10:00","items":[]}]}]}
        """#
        let card = try! JSONDecoder().decode(ConversationMealPlanProposal.self, from: Data(json.utf8))
        let clocks = ["Śniadanie": "08:30"]
        XCTAssertEqual(MealPlanCardCount.reminders(days: card.days, clock: { $0.time ?? clocks[$0.title] }, now: now, calendar: calendar), 2, "breakfast today has passed, the activity gets no reminder of its own")
        XCTAssertEqual(MealPlanCardCount.reminders(days: card.days, clock: { $0.time }, now: now, calendar: calendar), 3, "with no hour set yet it may still come")
        XCTAssertEqual(MealPlanCardCount.title(count: 1, patientName: "Ania"), "Włącz 1 przypomnienie: Ania")
        XCTAssertEqual(MealPlanCardCount.title(count: 4, patientName: nil), "Włącz 4 przypomnienia")
        XCTAssertEqual(MealPlanCardCount.title(count: 12, patientName: nil), "Włącz 12 przypomnień")
    }

    func testAPlanSaysOnItsLastDayThatItEnds() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        let meal = { (at: String) in MealPlanEntry(id: at, plan_id: "p", kind: "MEAL", title: "Obiad", planned_at: at, items: []) }
        let entries = [meal("2026-11-12T11:30:00Z"), meal("2026-11-13T11:30:00Z")]
        let last = calendar.date(from: DateComponents(year: 2026, month: 11, day: 13))!
        XCTAssertEqual(MealPlanEnd.line(entries: entries, selectedDay: last, calendar: calendar), "Plan kończy się w dniu: piątek, 13 listopada. Po nim nie będzie przypomnień.")
        XCTAssertNil(MealPlanEnd.line(entries: entries, selectedDay: calendar.date(from: DateComponents(year: 2026, month: 11, day: 12))!, calendar: calendar))
    }

    func testOnlyALowOrFallingGlucoseOffersTheOtherDoses() throws {
        func preview(reason: String?, defaultU: Double = 3, icr: Double? = 4.2) throws -> RemoteCommandPreview {
            let context = #"{"now":"2026-11-05T12:00:00Z","glucose":null,"loop":null,"last_bolus":null,"icr_g_per_u":8}"#
            let json = #"{"carbs_g":30,"insulin_u":3,"icr_g_per_u":8,"icr_insulin_u":4.2,"context":\#(context),"blocks":[],"warnings":[],"dose_calculation":{"default_u":\#(defaultU),"icr_dose_u":\#(icr.map { String($0) } ?? "null"),"calculator_u":3,"limited_by":"DROP","summary":"Cukier spada","reason_code":\#(reason.map { "\"\($0)\"" } ?? "null")}}"#
            return try JSONDecoder().decode(RemoteCommandPreview.self, from: Data(json.utf8))
        }
        XCTAssertEqual(MealPlanLoweredDose.of(try preview(reason: "FALLING")), MealPlanLoweredDose(dose: 3, icrDose: 4.2, line: "Cukier spada"))
        XCTAssertEqual(MealPlanLoweredDose.of(try preview(reason: "LOW_CARBS_FIRST", defaultU: 0))?.dose, 0)
        XCTAssertNil(MealPlanLoweredDose.of(try preview(reason: "ACTIVE_INSULIN")), "active insulin is no reason to offer more")
        XCTAssertNil(MealPlanLoweredDose.of(try preview(reason: nil)))
        XCTAssertNil(MealPlanLoweredDose.of(try preview(reason: "FALLING", defaultU: 5))?.icrDose, "never offers less as the whole dose")
    }

    func testACardReadsWhatItLacksAndTheChatsNoteOffer() throws {
        let card = try JSONDecoder().decode(ConversationMealPlanProposal.self, from: Data(#"{"id":"c","status":"PROPOSED","unread":["obiad we wtorek"],"replaces":2,"patient_name":"Ania","first_date":"2026-11-09"}"#.utf8))
        XCTAssertEqual(card.unread, ["obiad we wtorek"])
        XCTAssertEqual(card.replaces, 2)
        XCTAssertEqual(MealPlanDayText.date(card.first_date ?? "", calendar: Calendar(identifier: .gregorian)).map { Calendar(identifier: .gregorian).component(.day, from: $0) }, 9)
        let note = try JSONDecoder().decode(ConversationFoodNoteProposal.self, from: Data(#"{"id":"n","text":"Zwykle zostaje na talerzu: Buraczki","confirmed":false}"#.utf8))
        XCTAssertFalse(note.confirmed)
    }
}

private struct PlanListAPI: MealPlanAPI {
    let entries: [MealPlanEntry]
    func listMealPlan(patientID: String, from: String, to: String) async throws -> MealPlanListResponse {
        MealPlanListResponse(patient_id: patientID, entries: entries)
    }
    func setMealPlanEntryStatus(patientID: String, entryID: String, status: String) async throws -> MealPlanEntryResponse {
        throw CancellationError()
    }
}
