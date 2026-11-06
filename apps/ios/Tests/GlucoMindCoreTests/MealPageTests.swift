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
