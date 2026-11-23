import XCTest
@testable import GlucoMindCore

final class TherapyPatternsTests: XCTestCase {
    private let patient = "0f5b4c2e-1111-4a2b-9c3d-123456789abc"

    func testPushOpensThePatternCard() {
        let path = "/patients/\(patient)/patterns/MEAL_RISES_SAME_TIME.1800-2400"
        let payload: [AnyHashable: Any] = ["gluco": ["type": "therapy_pattern", "patientId": patient, "patternKey": "MEAL_RISES_SAME_TIME.1800-2400", "routePath": path]]
        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .therapyPattern(patientID: patient, key: "MEAL_RISES_SAME_TIME.1800-2400"))
        XCTAssertEqual(AppRoute.parse(universalLink: URL(string: "https://app.mellis.invalid\(path)")!), .therapyPattern(patientID: patient, key: "MEAL_RISES_SAME_TIME.1800-2400"))
    }

    func testBadKeyOpensThePatient() {
        let payload: [AnyHashable: Any] = ["gluco": ["type": "therapy_pattern", "patientId": patient, "routePath": "/patients/\(patient)/patterns/..%2Fx"]]
        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .patient(patientID: patient))
    }

    func testDecodesTheServerView() throws {
        let json = #"{"patient_id":"p","version":"therapy-patterns.v1","computed_at":"2026-11-11T03:05:00.000Z","window":{"from":"2026-10-28","to":"2026-11-10"},"patterns":[{"key":"SETTING_CHECK","id":"SETTING_CHECK","title":"Ustawienia do omówienia z poradnią","summary":"1 ustawienie do omówienia","sentence":"Czas działania insuliny (DIA) w Trio: 10 godzin.","lines":["Czas działania insuliny (DIA) w Trio: 10 godzin."],"question":null,"visit":"czy te ustawienia pasują do obecnej insuliny.","can_dismiss":true,"episode_count":0,"episodes":[],"first_seen":"2026-10-11","last_seen":"2026-11-11","is_new":false,"dismissed_until":null}],"gone":[],"dismissed":[]}"#
        let view = try JSONDecoder().decode(TherapyPatternsView.self, from: Data(json.utf8))
        XCTAssertEqual(view.patterns.first?.key, "SETTING_CHECK")
        XCTAssertFalse(view.patterns[0].isLows)
        XCTAssertTrue(view.patterns[0].isSettings)
        XCTAssertNil(view.patterns[0].question)
    }

    private func view(patterns: String, change: String) throws -> TherapyPatternsView {
        let json = #"{"computed_at":"2026-11-12T03:05:00.000Z","window":{"from":"2026-10-29","to":"2026-11-11"},"change_check":"# + change + #","patterns":["# + patterns + #"],"gone":[],"dismissed":[]}"#
        return try JSONDecoder().decode(TherapyPatternsView.self, from: Data(json.utf8))
    }

    private let change = #"{"key":"CHANGE_CHECK.2026-11-06","title":"Zmiana z 6.11","changes":[],"hours":"18:00–3:00","day":4,"of":14,"before_days":14,"after_days":4,"rows":[],"question":null,"sections":[{"title":"w godzinach 18:00–3:00","before_days":14,"after_days":4,"rows":[{"label":"Dni ze spadkiem poniżej 54","before":"3 z 14","after":"0 z 4"}]}],"context":[],"before_note":null,"note":"Bez oceny: 4 dni po zmianie to za mało, a w tych tygodniach mogły się zmienić też posiłki i sposób podawania bolusa."}"#
    private let lows = #"{"key":"NIGHT_LOWS","id":"NIGHT_LOWS","title":"Spadki w nocy","summary":"s","sentence":"s","lines":[],"question":null,"visit":"v","can_dismiss":false,"episode_count":3,"episodes":[],"first_seen":"2026-11-01","last_seen":"2026-11-12","is_new":false,"dismissed_until":null}"#

    /// Role review 2026-11-12: a running change card hid new lows patterns on Teraz for 14 days.
    func testLowsWinOverTheChangeOnTeraz() throws {
        let row = TherapyPatternsDashboardRow.row(try view(patterns: lows, change: change))!
        XCTAssertEqual(row.title, "Wzorce")
        XCTAssertEqual(row.caption, "1 do omówienia · zmiana: dzień 4 z 14 ›")
        XCTAssertEqual(row.spoken, "Wzorce: 1 do omówienia, dotyczy spadków. Zmiana z 6.11, dzień 4 z 14.")
        XCTAssertTrue(row.isLows) // a night under 54: red
        XCTAssertNil(row.progress)
        let only = TherapyPatternsDashboardRow.row(try view(patterns: "", change: change))!
        XCTAssertEqual(only.title, "Zmiana z 6.11")
        XCTAssertEqual(only.caption, "dzień 4 z 14 ›")
        XCTAssertEqual(try view(patterns: "", change: change).change_check?.sections?.first?.rows.first?.after, "0 z 4")
    }

    func testChangeSectionDecodesTonesValuesAndMeanLines() throws {
        let change = #"{"key":"CHANGE_CHECK.2026-11-06","title":"Zmiana z 6.11","ready":true,"changes":[],"day":14,"of":14,"rows":[],"sections":[{"title":"Przelicznik 18:00–24:00: 7,1 → 6,8 (więcej insuliny)","changes":[{"label":"Przelicznik 18:00–24:00","before":"7,1","after":"6,8"}],"direction":"MORE","direction_label":"więcej insuliny","before_days":14,"after_days":14,"rows":[{"label":"Poniżej 54","before":"0,4%","after":"1,4%","tone":"WORSE"},{"label":"Powyżej 180","before":"26%","after":"15%","tone":"BETTER"},{"label":"Poniżej 70","before":"5,1%","after":"4,5%","tone":null}],"chart":{"from_minute":1080,"to_minute":1620,"before":[[1080,133],[1620,133]],"after":[[1080,121],[1620,128]]}}]}"#
        let section = try XCTUnwrap(try view(patterns: "", change: change).change_check?.sections?.first)
        XCTAssertEqual(section.changes?.first?.after, "6,8")
        XCTAssertEqual(section.direction_label, "więcej insuliny")
        XCTAssertEqual(section.rows.map(\.isWorse), [true, false, false])
        XCTAssertEqual(section.rows.map(\.isBetter), [false, true, false])
        XCTAssertEqual(section.chart?.to_minute, 1620)
        XCTAssertEqual(section.chart?.after.last, [1620, 128])
    }

    func testOpenedPatternIsNoLongerNewOnTeraz() throws {
        let new = lows.replacingOccurrences(of: #""is_new":false"#, with: #""is_new":true"#)
        XCTAssertEqual(TherapyPatternsDashboardRow.row(try view(patterns: new, change: "null"))?.caption, "Spadki w nocy ›")
        XCTAssertEqual(TherapyPatternsDashboardRow.row(try view(patterns: lows, change: "null"))?.caption, "1 do omówienia ›")
        XCTAssertNil(TherapyPatternsDashboardRow.row(try view(patterns: "", change: "null")))
    }
}

final class MessageTableTests: XCTestCase {
    func testPipeTableBecomesATableSegment() {
        let text = "Wynik:\n\n| wariant | poniżej 70 |\n|---|---|\n| teraz | 750 min |\n| 7,5 | 550–610 |\n\nKoniec."
        XCTAssertEqual(MessageContentSegment.parse(text), [.text("Wynik:"), .table([["wariant", "poniżej 70"], ["teraz", "750 min"], ["7,5", "550–610"]]), .text("Koniec.")])
    }

    func testSingleLineWithPipesStaysText() {
        XCTAssertEqual(MessageContentSegment.parse("a | b | c"), [.text("a | b | c")])
    }
}
