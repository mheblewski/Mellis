import XCTest
@testable import GlucoMindCore

final class ConversationStartersTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Warsaw")!
        return calendar
    }()

    private func at(_ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: 20, hour: hour, minute: minute))!
    }

    private func reading(_ value: Int, direction: String? = "Flat", delta: Int? = nil, minutesAgo: Int = 3, now: Date) -> DashboardGlucose {
        let observed = now.addingTimeInterval(TimeInterval(-minutesAgo * 60))
        return DashboardGlucose(value: value, unit: "mg/dL", direction: direction, observed_at: ISO8601DateFormatter().string(from: observed), delta: delta)
    }

    private func hot(_ glucose: DashboardGlucose?, now: Date) -> ConversationStarter {
        ConversationStarters.make(glucose: glucose, now: now, calendar: calendar)[0]
    }

    func testAlwaysThreeCardsWithOnlyTheFirstHotAndTheSameLastTwo() {
        let starters = ConversationStarters.make(glucose: nil, now: at(14), calendar: calendar)
        XCTAssertEqual(starters.map(\.isHot), [true, false, false])
        XCTAssertEqual(starters[1].title, "Podsumuj ostatnią dobę")
        XCTAssertEqual(starters[2].title, "Policz posiłek")
        XCTAssertEqual(starters[2].action, .mealPhoto)
    }

    func testMealCardAsksForTheBolusOnlyWithRemoteControl() {
        let plain = ConversationStarters.make(glucose: nil, now: at(14), calendar: calendar)[2]
        let withBolus = ConversationStarters.make(glucose: nil, now: at(14), bolusCards: true, calendar: calendar)[2]
        XCTAssertEqual(plain.subtitle, "Ze zdjęcia: WW i WBT")
        XCTAssertEqual(withBolus.subtitle, "Ze zdjęcia: WW, WBT i bolus")
        XCTAssertEqual(ConversationStarters.mealPhotoDraft(bolusCards: false), "Policz WW i WBT tego posiłku.")
        XCTAssertEqual(ConversationStarters.mealPhotoDraft(bolusCards: true), "Policz WW, WBT i bolus tego posiłku.")
    }

    func testMorningInRangeAsksAboutTheNight() {
        let now = at(7, 15)
        XCTAssertEqual(hot(reading(120, now: now), now: now).title, "Jak minęła noc?")
    }

    func testEveningAndEarlyNightAskWhetherTheNightWillBeCalm() {
        XCTAssertEqual(hot(nil, now: at(21)).title, "Czy noc będzie spokojna?")
        XCTAssertEqual(hot(nil, now: at(2, 30)).title, "Czy noc będzie spokojna?")
        XCTAssertEqual(hot(nil, now: at(5)).title, "Jak minęła noc?")
        XCTAssertEqual(hot(nil, now: at(20, 59)).title, "Jak minęła noc?")
    }

    func testHighAndRisingAsksWhyItRisesWithTheValueAndArrow() {
        let now = at(14, 20)
        let starter = hot(reading(182, direction: "FortyFiveUp", now: now), now: now)
        XCTAssertEqual(starter.title, "Dlaczego cukier rośnie?")
        XCTAssertEqual(starter.subtitle, "182 ↗ · dane z ostatnich 3 h")
        XCTAssertEqual(starter.highlight, "182 ↗")
        XCTAssertEqual(starter.highlightLevel, .warning)
        XCTAssertEqual(starter.action, .send("Dlaczego cukier teraz rośnie?"))
    }

    func testOutOfRangeWinsOverTheTimeOfDay() {
        let now = at(22, 40)
        XCTAssertEqual(hot(reading(260, direction: "Flat", now: now), now: now).title, "Dlaczego cukier jest wysoki?")
        XCTAssertEqual(hot(reading(260, now: now), now: now).highlightLevel, .alarm)
    }

    func testLowAsksWhyItFallsOrIsLow() {
        let now = at(10)
        XCTAssertEqual(hot(reading(65, direction: "SingleDown", now: now), now: now).title, "Dlaczego cukier spada?")
        XCTAssertEqual(hot(reading(65, direction: "FortyFiveUp", now: now), now: now).title, "Dlaczego cukier jest niski?")
    }

    func testWithoutADirectionTheDeltaGivesTheTrend() {
        let now = at(14)
        // The Bolus tab's cut-offs (Nightscout's): more than 5 mg/dl in 5 minutes is a rising arrow.
        XCTAssertEqual(hot(reading(200, direction: nil, delta: 6, now: now), now: now).title, "Dlaczego cukier rośnie?")
        XCTAssertEqual(hot(reading(200, direction: nil, delta: 6, now: now), now: now).subtitle, "200 ↗ · dane z ostatnich 3 h")
        XCTAssertEqual(hot(reading(200, direction: nil, delta: 4, now: now), now: now).title, "Dlaczego cukier jest wysoki?")
        XCTAssertEqual(hot(reading(200, direction: nil, delta: 4, now: now), now: now).subtitle, "200 → · dane z ostatnich 3 h")
        XCTAssertEqual(hot(reading(200, direction: nil, now: now), now: now).subtitle, "200 · dane z ostatnich 3 h")
    }

    func testOneTrendRuleForEveryScreen() {
        XCTAssertEqual(GlucoseTrend.direction(nightscout: "SingleDown", delta: 30), "SingleDown")
        XCTAssertEqual(GlucoseTrend.direction(nightscout: "NOT COMPUTABLE", delta: -12), "SingleDown")
        XCTAssertEqual(GlucoseTrend.direction(nightscout: nil, delta: 18), "DoubleUp")
        XCTAssertEqual(GlucoseTrend.direction(nightscout: nil, delta: -5), "Flat")
        XCTAssertNil(GlucoseTrend.direction(nightscout: nil, delta: nil))
        XCTAssertEqual(GlucoseTrend.movement("FortyFiveDown"), .falling)
        XCTAssertEqual(GlucoseTrend.movement(nil), .steady)
        XCTAssertEqual(GlucoseTrend.arrowCharacter("DoubleDown"), "⇊")
        XCTAssertEqual(GlucoseTrend.label("Flat"), "Stabilnie")
    }

    func testAReadingOlderThan15MinutesFallsBackToTheTimeOfDay() {
        let now = at(14)
        XCTAssertEqual(hot(reading(240, minutesAgo: 15, now: now), now: now).id, "glucose")
        XCTAssertEqual(hot(reading(240, minutesAgo: 16, now: now), now: now).title, "Jak minęła noc?")
    }

    func testGreetingFollowsTheTimeOfDayAndUsesTheFirstName() {
        XCTAssertEqual(ConversationStarters.greeting(name: "Piotr Kowalski", now: at(7), calendar: calendar), "Dzień dobry, Piotr")
        XCTAssertEqual(ConversationStarters.greeting(name: "Piotr", now: at(18), calendar: calendar), "Dobry wieczór, Piotr")
        XCTAssertEqual(ConversationStarters.greeting(name: nil, now: at(4, 59), calendar: calendar), "Dobry wieczór")
        XCTAssertEqual(ConversationStarters.greeting(name: "  ", now: at(12), calendar: calendar), "Dzień dobry")
    }

    func testDecodesTheCaregiverNameAndToleratesOlderServers() throws {
        let withName = try JSONDecoder().decode(AccessiblePatientsResponse.self, from: Data(#"{"user_id":"u","user_display_name":"Piotr","patients":[]}"#.utf8))
        XCTAssertEqual(withName.user_display_name, "Piotr")
        let older = try JSONDecoder().decode(AccessiblePatientsResponse.self, from: Data(#"{"user_id":"u","patients":[]}"#.utf8))
        XCTAssertNil(older.user_display_name)
    }
}
