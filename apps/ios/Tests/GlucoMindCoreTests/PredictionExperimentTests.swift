import XCTest
@testable import GlucoMindCore

final class PredictionExperimentTests: XCTestCase {
    func testServerWithoutTheFeatureReadsAsNil() throws {
        let sent = PatientCapabilitiesResponse(patient_id: "p1", remote_commands: .off)
        let answer = try JSONDecoder().decode(PatientCapabilitiesResponse.self, from: JSONEncoder().encode(sent))
        XCTAssertNil(answer.prediction_experiment)
    }

    func testAccessDecodes() throws {
        let json = #"{"available":true,"enabled":true,"can_change":false}"#
        let access = try JSONDecoder().decode(PredictionExperimentAccess.self, from: Data(json.utf8))
        XCTAssertEqual(access, PredictionExperimentAccess(available: true, enabled: true, can_change: false))
    }

    func testComparisonDecodesAndReadsAsSentences() throws {
        let json = #"{"available":true,"enabled":true,"can_change":true,"low_comparison":{"policy_version":"low-comparison.v1","from":"2026-11-09T20:30:00.000Z","to":"2026-11-30T20:30:00.000Z","days":21.4,"lows":34,"model":{"lows_warned":21,"alerts_per_day":4.1,"alerts_without_low_per_day":2.3},"rules":{"lows_warned":17,"alerts_per_day":5,"alerts_without_low_per_day":3.6},"live_source":"MODEL","ready":true,"computed_at":"2026-11-30T21:00:00.000Z"}}"#
        let comparison = try XCTUnwrap(JSONDecoder().decode(PredictionExperimentAccess.self, from: Data(json.utf8)).low_comparison)
        XCTAssertEqual(LowWarningComparisonText.result(comparison), [
            "Dni z danymi: 21. Spadki poniżej 70: 34.",
            "Nowy model ostrzegł przed 21 z nich, dotychczasowe reguły przed 17.",
            "Alerty dziennie: nowy model 4,1, dotychczasowe reguły 5,0.",
            "Alerty, po których przez godzinę nie było spadku: nowy model 2,3 dziennie, dotychczasowe reguły 3,6 dziennie.",
            "Alerty wysyła teraz nowy model.",
            "Liczby są przybliżone: gdy po alercie ktoś poda węglowodany, spadku może nie być.",
        ])
        XCTAssertTrue(LowWarningComparisonText.share(comparison).hasPrefix("Ostrzeganie przed spadkiem: porównanie\nDni z danymi: 21."))
        XCTAssertEqual(LowWarningComparisonText.passOn, "Przekaż ten wynik Mateuszowi.")
        let collecting = LowWarningComparison(days: 5.9, lows: 8, model: comparison.model, rules: comparison.rules, live_source: "RULES", ready: false)
        XCTAssertEqual(LowWarningComparisonText.collecting(collecting)[1], "Dni z danymi: 5. Spadki poniżej 70: 8.")
    }

    func testResponseDecodes() throws {
        let json = #"{"patient_id":"p1","enabled":false}"#
        let response = try JSONDecoder().decode(PredictionExperimentResponse.self, from: Data(json.utf8))
        XCTAssertFalse(response.enabled)
    }
}

final class ChartPredictionLineTests: XCTestCase {
    private func response(_ line: String) throws -> PredictionResponse {
        let json = #"{"patient_id":"p1","prediction":{"engine_version":"prediction-engine.v1","loop":{"glucose":{"at":"2026-11-06T12:00:00.000Z","value":124}},"line":\#(line)}}"#
        return try JSONDecoder().decode(PredictionResponse.self, from: Data(json.utf8))
    }

    func testVisibleLineStartsFromTheNewestReading() throws {
        let line = ChartPredictionLine(try response(#"{"points":[{"at":"2026-11-06T12:15:00.000Z","value":128,"low":110,"high":146}],"hidden_reason":null}"#))
        XCTAssertEqual(line?.originValue, 124)
        XCTAssertEqual(line?.points.count, 1)
        XCTAssertNil(line?.hiddenText)
        XCTAssertEqual(line?.points.first?.high, 146)
    }

    func testHiddenLineHasAReasonAndNoPoints() throws {
        let line = ChartPredictionLine(try response(#"{"points":[],"hidden_reason":"LOW_RANGE"}"#))
        XCTAssertEqual(line?.hiddenText, "Bez prognozy: cukier poniżej 100")
        XCTAssertEqual(line?.points, [])
        XCTAssertEqual(line?.isStale(now: 9_999_999_999), false)
    }

    func testUnknownReasonStillHides() {
        XCTAssertEqual(PredictionExperimentText.hidden("SOMETHING_NEW"), "Bez prognozy")
    }

    func testNoLineAndEmptyPointsDrawNothing() throws {
        XCTAssertNil(ChartPredictionLine(try response("null")))
        XCTAssertNil(ChartPredictionLine(try response(#"{"points":[],"hidden_reason":null}"#)))
    }

    func testOldOriginIsStale() throws {
        let line = try XCTUnwrap(ChartPredictionLine(try response(#"{"points":[{"at":"2026-11-06T12:15:00.000Z","value":128,"low":110,"high":146}],"hidden_reason":null}"#)))
        XCTAssertFalse(line.isStale(now: line.originT + 19 * 60))
        XCTAssertTrue(line.isStale(now: line.originT + 21 * 60))
    }
}

final class ChartPredictionMorphTests: XCTestCase {
    private func line(origin: Double, _ values: [Double]) -> ChartPredictionLine {
        ChartPredictionLine(
            originT: origin, originValue: values.first ?? 0,
            points: values.enumerated().map { .init(t: origin + Double($0.offset + 1) * 900, value: $0.element, low: $0.element - 10, high: $0.element + 10) },
            hiddenText: nil
        )
    }

    func testEndsAreTheTwoLines() {
        let old = line(origin: 0, [100, 110])
        let new = line(origin: 300, [120, 140])
        XCTAssertEqual(new.morphed(from: old, progress: 0).points, old.points)
        XCTAssertEqual(new.morphed(from: old, progress: 1), new)
    }

    func testHalfwayIsBetweenThem() {
        let moved = line(origin: 300, [120, 140]).morphed(from: line(origin: 0, [100, 110]), progress: 0.5)
        XCTAssertEqual(moved.originT, 150)
        XCTAssertEqual(moved.points.map(\.value), [110, 125])
        XCTAssertEqual(moved.points.map(\.high), [120, 135])
    }

    func testDifferentLengthsKeepTheNewCount() {
        let moved = line(origin: 0, [100, 120, 140]).morphed(from: line(origin: 0, [100, 140]), progress: 0)
        XCTAssertEqual(moved.points.map(\.value), [100, 120, 140])
    }

    func testAHiddenOldLineMovesNothing() {
        let new = line(origin: 0, [100])
        XCTAssertEqual(new.morphed(from: ChartPredictionLine(originT: 0, originValue: 0, points: [], hiddenText: "x"), progress: 0), new)
    }
}

final class BolusSummaryWithPredictionTests: XCTestCase {
    private let lineLow = RemoteCommandNotice(code: "DOSE_LINE_LOW", key: "DOSE_LINE_LOW:2:1.5:BELOW_70", message: "Po tej dawce ok. 62 mg/dL: z tą dawką prognoza schodzi do ok. 62 mg/dL (linia przerywana; zakłada, że pętla nic więcej nie zmieni). 2 j to 0,5 j więcej niż propozycja (1,5 j). Rozważ mniejszą dawkę.", severity: "DANGER")

    func testOffKeepsTodaysText() throws {
        let item = try XCTUnwrap(BolusCheckSummary.make(forecastLowAt: nil, warnings: [lineLow]).items.first)
        XCTAssertEqual(item.headline, "Po tej dawce ok. 62 mg/dL")
    }

    func testOnDropsTheNumberButKeepsLevelConfirmationAndTheRest() throws {
        let off = try XCTUnwrap(BolusCheckSummary.make(forecastLowAt: nil, warnings: [lineLow]).items.first)
        let on = try XCTUnwrap(BolusCheckSummary.make(forecastLowAt: nil, warnings: [lineLow], hidesLineNumber: true).items.first)
        XCTAssertEqual(on.headline, PredictionExperimentText.doseLineHeadline)
        XCTAssertFalse(on.detail?.contains("62") ?? true)
        XCTAssertTrue(on.detail?.contains("2 j to 0,5 j więcej niż propozycja") ?? false)
        XCTAssertTrue(on.detail?.contains("Rozważ mniejszą dawkę") ?? false)
        XCTAssertEqual(on.level, off.level)
        XCTAssertEqual(on.needsConfirmation, off.needsConfirmation)
        XCTAssertEqual(on.id, off.id)
    }

    func testOtherWarningsAreUntouched() throws {
        let other = RemoteCommandNotice(code: "RECENT_BOLUS", key: "RECENT_BOLUS", message: "Bolus 1,2 j podano 20 min temu.", severity: "WARNING")
        let off = try XCTUnwrap(BolusCheckSummary.make(forecastLowAt: nil, warnings: [other]).items.first)
        let on = try XCTUnwrap(BolusCheckSummary.make(forecastLowAt: nil, warnings: [other], hidesLineNumber: true).items.first)
        XCTAssertEqual(on, off)
    }
}

final class PredictionPlanTests: XCTestCase {
    private func response(plan: String, rise: String = "[]", line: String = #"{"points":[],"hidden_reason":"LOW_RANGE"}"#) throws -> PredictionResponse {
        let json = #"{"patient_id":"p1","prediction":{"loop":{"glucose":{"at":"2026-11-06T12:00:00.000Z","value":124}},"line":\#(line),"plan":\#(plan),"late_rise":\#(rise)}}"#
        return try JSONDecoder().decode(PredictionResponse.self, from: Data(json.utf8))
    }

    func testMarkersKeepWhenTheLineIsHidden() throws {
        let line = try XCTUnwrap(ChartPredictionLine(try response(plan: #"[{"kind":"WBT_INSULIN","at":"2026-11-06T13:00:00.000Z","title":null,"state":"PLANNED"}]"#)))
        XCTAssertNotNil(line.hiddenText)
        XCTAssertEqual(line.markers.first?.label, "Insulina WBT")
        XCTAssertEqual(line.markers.first?.settled, false)
    }

    func testLabelsSayTheStateAndTheTitle() {
        XCTAssertEqual(PredictionExperimentText.marker(kind: "BOLUS_PART", title: nil, state: "SKIPPED"), "Druga część · pominięto")
        XCTAssertEqual(PredictionExperimentText.marker(kind: "BOLUS_PART", title: nil, state: "DONE_EARLY"), "Druga część · już podano")
        XCTAssertEqual(PredictionExperimentText.marker(kind: "PLANNED_MEAL", title: "Obiad", state: "PLANNED"), "Obiad")
    }

    func testStaleLineDropsThePointsButNotThePlan() throws {
        let line = try XCTUnwrap(ChartPredictionLine(try response(
            plan: #"[{"kind":"BOLUS_PART","at":"2026-11-06T13:00:00.000Z","title":null,"state":"PLANNED"}]"#,
            line: #"{"points":[{"at":"2026-11-06T12:15:00.000Z","value":128,"low":110,"high":146}],"hidden_reason":null}"#
        )))
        XCTAssertTrue(line.isStale(now: line.originT + 21 * 60))
        let kept = line.withoutLine()
        XCTAssertEqual(kept.points, [])
        XCTAssertEqual(kept.markers.count, 1)
        XCTAssertFalse(kept.isStale(now: line.originT + 21 * 60))
    }

    func testOlderServerWithoutPlanStillDecodes() throws {
        let json = #"{"patient_id":"p1","prediction":{"loop":{"glucose":null},"line":{"points":[],"hidden_reason":"NO_FRESH_READING"}}}"#
        let response = try JSONDecoder().decode(PredictionResponse.self, from: Data(json.utf8))
        XCTAssertEqual(ChartPredictionLine(response)?.markers, [])
    }
}

@MainActor
final class PredictionLineAccessTests: XCTestCase {
    private struct API: PatientCapabilitiesAPI {
        let json: String
        func getCapabilities(patientID: String) async throws -> PatientCapabilitiesResponse {
            try JSONDecoder().decode(PatientCapabilitiesResponse.self, from: Data(json.utf8))
        }
    }

    private func available(_ json: String) async -> Bool {
        let store = PatientCapabilitiesStore()
        await store.refresh(api: API(json: json), patientID: "p1")
        XCTAssertEqual(store.predictionLineAvailable, store.predictionLineAvailable(of: "p1"))
        return store.predictionLineAvailable
    }

    func testTheLineFollowsTheServersLineSwitchNotTheExperiment() async {
        let base = #""patient_id":"p1","remote_commands":{"enabled":false,"reason":"SERVER_DISABLED"}"#
        let off = #","prediction_experiment":{"available":true,"enabled":false,"can_change":true}"#
        let on = #","prediction_experiment":{"available":true,"enabled":true,"can_change":true}"#
        let lineOn = await available("{\(base),\"prediction_line\":{\"available\":true}\(off)}")
        XCTAssertTrue(lineOn, "on for everyone, the experiment off")
        let lineOff = await available("{\(base),\"prediction_line\":{\"available\":false}\(on)}")
        XCTAssertFalse(lineOff, "the server turned the line off")
        let olderOn = await available("{\(base)\(on)}")
        XCTAssertTrue(olderOn, "an older server: the line as the experiment says")
        let olderOff = await available("{\(base)\(off)}")
        XCTAssertFalse(olderOff)
    }

    func testThePhonesSwitchIsOnByDefault() {
        XCTAssertTrue(PredictionLinePreference.defaultShown)
    }
}
