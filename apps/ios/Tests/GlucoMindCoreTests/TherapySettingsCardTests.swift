import XCTest
@testable import GlucoMindCore

final class TherapySettingsCardTests: XCTestCase {
    /// As the server builds it (therapy-settings-card.v1): "Jakie jest ICR?" at 13:20 on 11 Nov 2026.
    private let json = #"""
    {"kind":"THERAPY_SETTINGS","period_label":"teraz","therapy":{"version":"therapy-settings-card.v1","patient_name":"Janek","source_label":"Trio","at":"13:20","is_now":true,"live_until":"2026-11-11T12:50:00.000Z","layout":"SINGLE","title":"ICR teraz","history_title":"ICR o 13:20","changed_label":"zmiana 3 lis","stale_label":null,"stale_text":null,"settings":[{"key":"ICR","name":"ICR","unit":"g na 1 j","segments":[{"start":"00:00","end":"06:00","value":10,"label":"10"},{"start":"06:00","end":"09:30","value":5,"label":"5"},{"start":"09:30","end":"18:00","value":8.3,"label":"8,3"},{"start":"18:00","end":"24:00","value":6.8,"label":"6,8"}],"current_index":2,"span_label":"od 9:30 do 18:00","previous":null,"next":null,"accessibility_label":"ICR: od 0:00 do 6:00 10 g na 1 j; od 6:00 do 9:30 5 g na 1 j; od 9:30 do 18:00 8,3 g na 1 j; od 18:00 do 24:00 6,8 g na 1 j; teraz 8,3"}],"sentence":"Ta wartość jest ustawiona od 9:30 do 18:00.","hour_note":null,"loop_now":null,"table":[{"start":"00:00","end":"06:00","values":[{"key":"ICR","label":"10","changed":true}],"current":false},{"start":"06:00","end":"09:30","values":[{"key":"ICR","label":"5","changed":true}],"current":false},{"start":"09:30","end":"18:00","values":[{"key":"ICR","label":"8,3","changed":true}],"current":true},{"start":"18:00","end":"24:00","values":[{"key":"ICR","label":"6,8","changed":true}],"current":false}],"footer":"Im mniej gramów na 1 j, tym więcej insuliny na ten sam posiłek.","basal_plan_total_u":9.15,"dia_hours":6,"missing":null}}
    """#
    private let noProfile = #"""
    {"kind":"THERAPY_SETTINGS","period_label":"teraz","therapy":{"version":"therapy-settings-card.v1","patient_name":"Janek","source_label":"Trio","at":"13:20","is_now":true,"live_until":"2026-11-11T12:50:00.000Z","layout":"NO_PROFILE","title":"","history_title":"","changed_label":null,"stale_label":null,"stale_text":null,"settings":[],"sentence":null,"hour_note":null,"loop_now":null,"table":[],"footer":null,"basal_plan_total_u":null,"dia_hours":null,"missing":{"title":"Mellis nie ma jeszcze ustawień z Trio.","text":"Pojawią się, gdy Trio wyśle profil do Nightscout."}}}
    """#

    func testDecodesTheCardAndShowsTheView() throws {
        let card = try JSONDecoder().decode(ConversationMetricCard.self, from: Data(json.utf8))
        let therapy = try XCTUnwrap(card.therapy)
        XCTAssertEqual(therapy.layout, "SINGLE")
        XCTAssertEqual(therapy.settings.first?.current?.label, "8,3")
        XCTAssertEqual(therapy.table.filter(\.current).map(\.start), ["09:30"])
        XCTAssertEqual(therapy.pillText, "Janek · Trio · zmiana 3 lis")
        XCTAssertNotNil(TherapySettingsCardView(card: card))
        XCTAssertNil(MetricCardView(card: card))
        XCTAssertNil(WhatIfCardView(card: card))
    }

    func testTerazLivesThirtyMinutes() throws {
        let therapy = try XCTUnwrap(JSONDecoder().decode(ConversationMetricCard.self, from: Data(json.utf8)).therapy)
        let formatter = ISO8601DateFormatter()
        XCTAssertTrue(therapy.isLive(at: try XCTUnwrap(formatter.date(from: "2026-11-11T12:49:00Z"))))
        XCTAssertFalse(therapy.isLive(at: try XCTUnwrap(formatter.date(from: "2026-11-11T12:51:00Z"))))
    }

    func testNoProfileCard() throws {
        let card = try JSONDecoder().decode(ConversationMetricCard.self, from: Data(noProfile.utf8))
        XCTAssertEqual(card.therapy?.missing?.title, "Mellis nie ma jeszcze ustawień z Trio.")
        XCTAssertNotNil(TherapySettingsCardView(card: card))
    }

    func testHours() {
        XCTAssertEqual(TherapySettingsCardView.hour("00:00"), "0:00")
        XCTAssertEqual(TherapySettingsCardView.hour("09:30"), "9:30")
        XCTAssertEqual(TherapySettingsCardView.hour("24:00"), "24:00")
        XCTAssertEqual(TherapySettingsCardView.minutes("13:20"), 800)
    }
}
