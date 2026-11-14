import XCTest
@testable import GlucoMindCore

final class DashboardTests: XCTestCase {
    private let patientID = "11111111-1111-4111-8111-111111111111"

    private var json: Data {
        """
        {
          "patient_id":"\(patientID)",
          "generated_at":"2026-10-17T12:41:00.000Z",
          "glucose":{"value":124,"unit":"mg/dL","direction":"FortyFiveUp","observed_at":"2026-10-17T12:38:00.000Z","delta":-12},
          "readings":[{"at":"2026-10-17T09:00:00.000Z","value":150},{"at":"2026-10-17T12:33:00.000Z","value":136},{"at":"2026-10-17T12:38:00.000Z","value":124}],
          "time_in_range":{"hours":24,"readings_count":287,"low_percent":2,"in_range_percent":81,"high_percent":17},
          "pump":{"battery_percent":51,"reservoir_units":69.4,"reservoir_full_units":89.3,"last_read_at":"2026-10-17T12:37:15.474Z"},
          "loop":{"iob_units":1.5,"cob_grams":6,"observed_at":"2026-10-17T12:37:18.046Z"},
          "site_changed_at":"2026-10-16T09:10:00.000Z",
          "sensor_started_at":null
        }
        """.data(using: .utf8)!
    }

    @MainActor
    func testDecodesTheDashboard() async throws {
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: DashboardHTTPClient(data: json))
        let viewModel = DashboardViewModel(apiClient: client, patientID: patientID)

        await viewModel.refresh()

        let dashboard = try XCTUnwrap(viewModel.dashboard)
        XCTAssertEqual(dashboard.glucose?.value, 124)
        XCTAssertEqual(dashboard.glucose?.delta, -12)
        XCTAssertEqual(dashboard.pump?.battery_percent, 51)
        XCTAssertEqual(dashboard.pump?.reservoir_units, 69.4)
        XCTAssertEqual(try XCTUnwrap(dashboard.pump?.reservoirFraction), 69.4 / 89.3, accuracy: 0.0001)
        XCTAssertEqual(dashboard.loop?.iob_units, 1.5)
        XCTAssertEqual(dashboard.loop?.cob_grams, 6)
        XCTAssertNotNil(dashboard.siteChangedAt)
        XCTAssertNil(dashboard.sensorStartedAt)
        // Older servers and a finished import send no nightscout_history: no row.
        XCTAssertNil(dashboard.nightscout_history)
    }

    /// The Nightscout history import (1.0.5): "Wczytuję historię z Nightscouta… 42%" while it runs.
    func testDecodesTheNightscoutHistoryImport() throws {
        var text = String(data: json, encoding: .utf8)!
        text = text.replacingOccurrences(of: "\"sensor_started_at\":null", with: "\"sensor_started_at\":null,\"nightscout_history\":{\"status\":\"LOADING\",\"progress_percent\":42}")
        let dashboard = try JSONDecoder().decode(DashboardResponse.self, from: Data(text.utf8))
        XCTAssertEqual(dashboard.nightscout_history?.rowText, "Wczytuję historię z Nightscouta… 42%")
        XCTAssertEqual(DashboardHistoryImport(progress_percent: nil).rowText, "Wczytuję historię z Nightscouta…")
        XCTAssertEqual(DashboardHistoryImport(progress_percent: 140).rowText, "Wczytuję historię z Nightscouta… 99%")
        XCTAssertNil(DashboardHistoryImport(status: "COMPLETE", progress_percent: 100).rowText)
        let plain = try JSONDecoder().decode(DashboardResponse.self, from: json)
        XCTAssertFalse(dashboard.hasSameData(as: plain), "progress changes refresh the row")
    }

    /// Pull to refresh: SwiftUI can cancel the gesture's task, and URLSession then throws -999. That is not a failure.
    @MainActor
    func testCancelledRequestKeepsTheDataWithoutAnError() async throws {
        let client = SequenceHTTPClient(results: [.success(json), .failure(URLError(.cancelled)), .failure(URLError(.notConnectedToInternet))])
        let viewModel = DashboardViewModel(apiClient: APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: client), patientID: patientID)

        await viewModel.refresh()
        await viewModel.refreshFromPull()
        XCTAssertNotNil(viewModel.dashboard)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)

        await viewModel.refreshFromPull()
        XCTAssertNotNil(viewModel.dashboard, "a real failure keeps the last data on screen")
        XCTAssertEqual(viewModel.errorMessage, "Nie udało się odświeżyć danych")
    }

    func testRefreshesShortlyAfterTheExpectedReading() throws {
        func dashboard(_ readings: [String]) -> DashboardResponse {
            DashboardResponse(patient_id: patientID, generated_at: "", glucose: nil, readings: readings.map { DashboardReading(at: $0, value: 120) }, time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        }
        let fiveMinute = dashboard(["2026-10-17T18:03:39.000Z", "2026-10-17T18:08:39.000Z"])
        let date = { (iso: String) in try XCTUnwrap(ISO8601DateFormatter().date(from: iso)) }

        // Next reading expected 18:13:39 -> refresh 18:13:54; capped at a minute.
        XCTAssertEqual(DashboardViewModel.nextRefreshDelay(after: fiveMinute, now: try date("2026-10-17T18:09:00Z")), .seconds(60))
        XCTAssertEqual(DashboardViewModel.nextRefreshDelay(after: fiveMinute, now: try date("2026-10-17T18:13:30Z")), .seconds(24))
        // The reading is late: every 20 s.
        XCTAssertEqual(DashboardViewModel.nextRefreshDelay(after: fiveMinute, now: try date("2026-10-17T18:14:10Z")), .seconds(20))
        // A 1-minute sensor.
        let oneMinute = dashboard(["2026-10-17T18:07:39.000Z", "2026-10-17T18:08:39.000Z"])
        XCTAssertEqual(DashboardViewModel.nextRefreshDelay(after: oneMinute, now: try date("2026-10-17T18:09:00Z")), .seconds(54))
        XCTAssertEqual(DashboardViewModel.nextRefreshDelay(after: nil, now: try date("2026-10-17T18:09:00Z")), .seconds(30))
    }

    func testReservoirBarFallsBackTo200UnitsWithoutAKnownFill() throws {
        let unknown = DashboardPump(battery_percent: nil, reservoir_units: 50, last_read_at: "")
        XCTAssertEqual(unknown.reservoirFraction, 0.25)
        let full = DashboardPump(battery_percent: nil, reservoir_units: 120, reservoir_full_units: 120, last_read_at: "")
        XCTAssertEqual(full.reservoirFraction, 1)
        XCTAssertNil(DashboardPump(battery_percent: nil, reservoir_units: nil, last_read_at: "").reservoirFraction)
    }

    func testRefreshWithTheSameDataIsNotAChange() {
        let first = DashboardResponse(patient_id: patientID, generated_at: "2026-10-17T18:00:00.000Z", glucose: nil, readings: [DashboardReading(at: "2026-10-17T17:58:39.000Z", value: 120)], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        let regenerated = DashboardResponse(patient_id: patientID, generated_at: "2026-10-17T18:00:20.000Z", glucose: nil, readings: first.readings, time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        let newReading = DashboardResponse(patient_id: patientID, generated_at: "2026-10-17T18:03:50.000Z", glucose: nil, readings: first.readings + [DashboardReading(at: "2026-10-17T18:03:39.000Z", value: 124)], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)

        XCTAssertTrue(regenerated.hasSameData(as: first))
        XCTAssertFalse(newReading.hasSameData(as: first))
        XCTAssertFalse(first.hasSameData(as: nil))
    }

    func testGlucoseThresholds() {
        XCTAssertEqual(DashboardThresholds.glucose(69), .alarm)
        XCTAssertEqual(DashboardThresholds.glucose(70), .normal)
        XCTAssertEqual(DashboardThresholds.glucose(180), .normal)
        XCTAssertEqual(DashboardThresholds.glucose(181), .warning)
        XCTAssertEqual(DashboardThresholds.glucose(250), .warning)
        XCTAssertEqual(DashboardThresholds.glucose(251), .alarm)
    }

    func testAgeThresholds() {
        XCTAssertEqual(DashboardThresholds.readingAge(minutes: 10), .normal)
        XCTAssertEqual(DashboardThresholds.readingAge(minutes: 11), .warning)
        XCTAssertEqual(DashboardThresholds.readingAge(minutes: 16), .alarm)
        XCTAssertEqual(DashboardThresholds.siteAge(hours: 48), .normal)
        XCTAssertEqual(DashboardThresholds.siteAge(hours: 49), .warning)
        XCTAssertEqual(DashboardThresholds.siteAge(hours: 73), .alarm)
        XCTAssertEqual(DashboardThresholds.sensorAge(hours: 9 * 24), .normal)
        XCTAssertEqual(DashboardThresholds.sensorAge(hours: 9 * 24 + 1), .warning)
        XCTAssertEqual(DashboardThresholds.sensorAge(hours: 10 * 24 + 1), .alarm)
    }

    func testPumpAndTimeInRangeThresholds() {
        XCTAssertEqual(DashboardThresholds.battery(percent: 30), .normal)
        XCTAssertEqual(DashboardThresholds.battery(percent: 29), .warning)
        XCTAssertEqual(DashboardThresholds.battery(percent: 19), .alarm)
        XCTAssertEqual(DashboardThresholds.reservoir(units: 25), .normal)
        XCTAssertEqual(DashboardThresholds.reservoir(units: 24.9), .warning)
        XCTAssertEqual(DashboardThresholds.reservoir(units: 9.9), .alarm)
        XCTAssertEqual(DashboardThresholds.timeInRange(percent: 70), .normal)
        XCTAssertEqual(DashboardThresholds.timeInRange(percent: 69), .warning)
        XCTAssertEqual(DashboardThresholds.timeInRange(percent: 49), .alarm)
        XCTAssertEqual(DashboardThresholds.timeBelowRange(percent: 4), .normal)
        XCTAssertEqual(DashboardThresholds.timeBelowRange(percent: 5), .alarm)
    }

    func testFormatting() {
        XCTAssertEqual(DashboardFormat.signedDelta(4), "+4")
        XCTAssertEqual(DashboardFormat.signedDelta(-12), "\u{2212}12")
        XCTAssertEqual(DashboardFormat.signedDelta(0), "0")
        XCTAssertTrue(DashboardFormat.dayHourParts(hours: 28.9) == (1, 4))
        XCTAssertEqual(DashboardFormat.units(112.4), "112")
        XCTAssertEqual(DashboardFormat.units(6.5), "6,5")
        XCTAssertEqual(DashboardFormat.units(6.0), "6")
        XCTAssertEqual(DashboardFormat.units(69.4), "69")
        XCTAssertEqual(DashboardFormat.iob(1.5), "1,50")
        XCTAssertEqual(DashboardFormat.iob(1.849), "1,85")
    }
}

private final class DashboardHTTPClient: HTTPClient {
    let data: Data

    init(data: Data) {
        self.data = data
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        XCTAssertEqual(request.url?.path, "/v1/patients/11111111-1111-4111-8111-111111111111/dashboard")
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private final class SequenceHTTPClient: HTTPClient, @unchecked Sendable {
    private var results: [Result<Data, Error>]

    init(results: [Result<Data, Error>]) {
        self.results = results
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data = try results.removeFirst().get()
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor
final class StarterGlucoseReadTests: XCTestCase {
    func testTheChatAndItsStarterCardsShareOneDashboardRead() async {
        let http = CountingDashboardHTTPClient()
        let api = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: http)
        let viewModel = ConversationViewModel(apiClient: api, patientID: "p")

        async let chat: Void = viewModel.refreshStarterGlucose()
        async let cards: Void = viewModel.refreshStarterGlucose()
        _ = await (chat, cards)

        XCTAssertEqual(http.dashboardReads, 1)
        XCTAssertEqual(viewModel.starterGlucose?.value, 124)
        XCTAssertTrue(viewModel.starterGlucoseSettled)

        // Right after a read the next empty conversation uses the same reading.
        await viewModel.refreshStarterGlucose()
        XCTAssertEqual(http.dashboardReads, 1)
    }
}

@MainActor
private final class CountingDashboardHTTPClient: HTTPClient {
    private(set) var dashboardReads = 0

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        dashboardReads += 1
        try await Task.sleep(nanoseconds: 20_000_000)
        let json = #"{"patient_id":"p","generated_at":"2026-10-17T12:41:00.000Z","glucose":{"value":124,"unit":"mg/dL","direction":"Flat","observed_at":"2026-10-17T12:38:00.000Z","delta":-2},"readings":[],"time_in_range":null,"pump":null,"loop":null,"site_changed_at":null,"sensor_started_at":null}"#
        return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

final class NowSituationTests: XCTestCase {
    private func decode(_ json: String) throws -> NowSituation {
        // The decoder APIClient uses: no date strategy, so dates must stay strings here.
        return try JSONDecoder().decode(NowSituation.self, from: Data(json.utf8))
    }

    private let now = ISO8601DateFormatter().date(from: "2026-11-07T12:00:00Z")!

    func testTheServersOwnFormatWithMillisecondsIsUsable() throws {
        let situation = try decode(#"{"state":"6","evaluated_at":"2026-11-07T11:58:00.123Z","sentence":"Glukoza jest poniżej 70.","glucose":{"value":66,"at":"2026-11-07T11:57:00.000Z","age_minutes":1,"tone":"RED"}}"#)
        XCTAssertTrue(situation.isUsable(now: now))
        XCTAssertNotNil(situation.glucose?.observedAt)
    }

    func testAFreshKnownSituationIsUsable() throws {
        let situation = try decode(#"{"state":"6","evaluated_at":"2026-11-07T11:58:00Z","sentence":"Glukoza jest poniżej 70.","second":{"kind":"DOSE","label":"Podaj","value":"5 g","unit":"szybkich węgli","note":null}}"#)
        XCTAssertTrue(situation.isUsable(now: now))
        XCTAssertTrue(situation.showsDose)
    }

    func testVeryOldReadingAgeStaysOneShortNumber() {
        XCTAssertEqual(StaleReading.shortSpan(minutes: 59), "59 min")
        XCTAssertEqual(StaleReading.shortSpan(minutes: 125), "2 h")
        XCTAssertEqual(StaleReading.shortSpan(minutes: 1600), "1 d")
    }

    private func shown(_ situation: NowSituation?, _ freshness: DashboardFreshness, failed: Bool = false, lastSuccessAt: Date? = nil) -> NowSituationDisplay {
        NowSituation.display(situation: situation, glucose: DashboardGlucose(value: 60, unit: "mg/dL", direction: nil, observed_at: "2026-11-07T10:00:00Z", delta: nil),
                             freshness: freshness, readFailed: failed, lastSuccessAt: lastSuccessAt, now: now)
    }

    func testOldSituationNeverFallsBackToThePlainHero() throws {
        let old = try decode(#"{"state":"7","evaluated_at":"2026-11-07T10:00:00Z","sentence":"Podaj.","glucose":{"value":50,"at":"2026-11-07T09:59:00Z","tone":"ON_RED"}}"#)
        XCTAssertEqual(shown(old, .refreshing), .waiting, "opening with an old saved read")
        XCTAssertEqual(shown(old, .fresh), .waiting, "aged on screen, the next read is on its way")

        let failed = shown(old, .failed, failed: true).situation
        XCTAssertEqual(failed?.sentence, "Nie udało się pobrać danych.")
        XCTAssertEqual(failed?.glucose?.tone, "STALE")
        XCTAssertEqual(failed?.detail, "Zmierz glukozę glukometrem.")
        XCTAssertNil(failed?.action)
        XCTAssertFalse(failed?.showsDose ?? true)
        XCTAssertNotNil(shown(old, .fresh, failed: true).situation, "failing, though not yet old enough to dim")
    }

    func testReadingOverFiveMinutesWaitsWhileReading() throws {
        let oldReading = try decode(#"{"state":"1d","evaluated_at":"2026-11-07T11:59:00Z","sentence":"W zakresie.","glucose":{"value":100,"at":"2026-11-07T11:54:00Z","tone":"NEUTRAL"}}"#)
        XCTAssertEqual(shown(oldReading, .refreshing), .waiting)
        let recent = try decode(#"{"state":"1d","evaluated_at":"2026-11-07T11:59:00Z","sentence":"W zakresie.","glucose":{"value":100,"at":"2026-11-07T11:58:00Z","tone":"NEUTRAL"}}"#)
        XCTAssertEqual(shown(recent, .refreshing).situation?.sentence, "W zakresie.")
    }

    func testPhoneClockAheadOfTheServerStillShowsAFreshRead() throws {
        let behind = try decode(#"{"state":"1d","evaluated_at":"2026-11-07T11:40:00Z","sentence":"W zakresie."}"#)
        XCTAssertEqual(shown(behind, .fresh, lastSuccessAt: now).situation?.sentence, "W zakresie.")
        let noDate = try decode(#"{"state":"1d","sentence":"W zakresie."}"#)
        XCTAssertEqual(shown(noDate, .fresh, lastSuccessAt: now).situation?.sentence, "W zakresie.")
    }

    func testPartsThisBuildCannotDrawGoButTheWordsStay() throws {
        let newer = try decode(#"{"state":"99","evaluated_at":"2026-11-07T11:59:00Z","sentence":"Nowy stan.","second":{"kind":"NEW","label":null,"value":"1","unit":null,"note":null},"action":{"kind":"NEW","label":"Zrób"}}"#)
        let drawn = shown(newer, .fresh).situation
        XCTAssertEqual(drawn?.sentence, "Nowy stan.")
        XCTAssertNil(drawn?.second)
        XCTAssertNil(drawn?.action)
    }

    func testAnEmptySituationGetsWordsInstead() throws {
        let empty = try decode(#"{"state":"6","evaluated_at":"2026-11-07T11:59:00Z"}"#)
        XCTAssertEqual(shown(empty, .fresh, lastSuccessAt: now).situation?.sentence, "Nie udało się pobrać danych.")
    }

    func testOnlyAReadWithoutASituationKeepsThePlainHero() {
        XCTAssertEqual(shown(nil, .fresh), .plainHero)
        XCTAssertEqual(shown(nil, .refreshing), .plainHero)
        XCTAssertEqual(shown(nil, .failed, failed: true), .plainHero)
    }

    func testAnOldOrUnknownOrEmptySituationIsNotDrawn() throws {
        XCTAssertFalse(try decode(#"{"state":"6","evaluated_at":"2026-11-07T11:54:00Z","sentence":"Glukoza jest poniżej 70."}"#).isUsable(now: now))
        XCTAssertTrue(try decode(#"{"state":"99","evaluated_at":"2026-11-07T11:59:00Z","sentence":"Nowy stan."}"#).isUsable(now: now))
        XCTAssertFalse(try decode(#"{"state":"6","evaluated_at":"2026-11-07T11:59:00Z"}"#).isUsable(now: now))
        XCTAssertFalse(try decode(#"{"state":"6","sentence":"Bez czasu."}"#).isUsable(now: now))
    }

    func testABrokenPartDoesNotCostTheSituation() throws {
        let situation = try decode(#"{"state":"1d","evaluated_at":"2026-11-07T11:59:00Z","sentence":"W zakresie.","action":"nowy format","glucose":{"value":"x"}}"#)
        XCTAssertNil(situation.action)
        XCTAssertNil(situation.glucose)
        XCTAssertTrue(situation.isUsable(now: now))
    }

    func testTheCheckCountsDownByItself() throws {
        let situation = try decode(#"{"state":"8","evaluated_at":"2026-11-07T11:59:00Z","sentence":"Podano 5 g o 11:54.","second":{"kind":"CHECK","label":"Kontrola za","value":"15 min","unit":null,"note":null},"check":{"carbs_at":"2026-11-07T11:54:00Z","carbs_g":5,"due_at":"2026-11-07T12:09:00Z"}}"#)
        XCTAssertEqual(situation.checkMinutesLeft(now: now), 9)
        XCTAssertEqual(situation.checkMinutesLeft(now: now.addingTimeInterval(3600)), 1)
        XCTAssertFalse(situation.showsDose)
    }

    func testADueCheckWithoutItsReadingWaitsInsteadOfOneMinute() throws {
        let situation = try decode(#"{"state":"8","evaluated_at":"2026-11-07T12:00:00Z","second":{"kind":"CHECK","label":"Kolejne sprawdzenie za","value":"3 min"},"sentence":"x","check":{"carbs_at":"2026-11-07T11:48:00Z","carbs_g":3,"due_at":"2026-11-07T12:03:00Z"}}"#)
        XCTAssertFalse(situation.checkWaitsForReading(now: now))
        XCTAssertEqual(situation.checkMinutesLeft(now: now), 3)
        XCTAssertTrue(situation.checkWaitsForReading(now: now.addingTimeInterval(4 * 60)))
        XCTAssertEqual(situation.checkMinutesPastDue(now: now.addingTimeInterval(7 * 60)), 4)
    }

    func testADueCheckWaitsOnlyOnceItsReadingIsTenMinutesOld() throws {
        let situation = try decode(#"{"state":"8","evaluated_at":"2026-11-07T12:00:00Z","second":{"kind":"CHECK","label":"Kolejne sprawdzenie za","value":"3 min"},"sentence":"x","glucose":{"value":66,"at":"2026-11-07T11:59:00Z","tone":"RED"},"check":{"carbs_at":"2026-11-07T11:48:00Z","carbs_g":3,"due_at":"2026-11-07T12:03:00Z"}}"#)
        XCTAssertTrue(situation.checkIsDue(now: now.addingTimeInterval(4 * 60)))
        XCTAssertFalse(situation.checkWaitsForReading(now: now.addingTimeInterval(4 * 60)))
        XCTAssertTrue(situation.checkWaitsForReading(now: now.addingTimeInterval(9 * 60)))
    }

    func testTheUndoWindowCountsDownAndEnds() throws {
        let situation = try decode(#"{"state":"8u","evaluated_at":"2026-11-07T12:00:00Z","sentence":"x","action":{"kind":"UNDO","label":"Cofnij","event_id":"e","until":"2026-11-07T12:00:03.500Z"}}"#)
        XCTAssertEqual(situation.undoSecondsLeft(now: now), 4)
        XCTAssertNil(situation.undoSecondsLeft(now: now.addingTimeInterval(4)))
        XCTAssertEqual(NowSituation.undoSentence(seconds: 5), "Węgle zostaną zapisane za 5 sekund.")
        XCTAssertEqual(NowSituation.undoSentence(seconds: 3), "Węgle zostaną zapisane za 3 sekundy.")
        XCTAssertEqual(NowSituation.undoSentence(seconds: 1), "Węgle zostaną zapisane za 1 sekundę.")
        // Two doers: the other caregiver's name stays and so does "Mellis" (voice review 2026-11-13).
        XCTAssertEqual(NowSituation.undoSentence(seconds: 4, serverSentence: "Ewa podała węgle. Mellis zapisze je za 5 sekund."), "Ewa podała węgle. Mellis zapisze je za 4 sekundy.")
    }

    @MainActor
    func testGivenCarbsLogThenReadAndAFailureIsReported() async throws {
        var reads = 0
        var logged: [Int] = []
        var fails = false
        let viewModel = DashboardViewModel(patientID: "p", fetch: { _ in
            reads += 1
            return DashboardResponse(patient_id: "p", generated_at: "2026-11-07T12:00:00Z", glucose: nil, readings: [], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        })
        viewModel.setSituationActions(log: { _, grams in
            if fails { throw URLError(.notConnectedToInternet) }
            logged.append(grams)
            return SituationCarbsResponse(status: "LOGGED")
        }, undo: { _, _ in SituationCarbsResponse(status: "TOO_LATE") })
        let done = await viewModel.logGivenCarbs(5)
        XCTAssertTrue(done)
        XCTAssertEqual(logged, [5])
        XCTAssertEqual(reads, 1)
        fails = true
        let failed = await viewModel.logGivenCarbs(5)
        XCTAssertFalse(failed)
        XCTAssertEqual(reads, 1)
        let tooLate = await viewModel.undoGivenCarbs(eventID: "e")
        XCTAssertTrue(tooLate)
        XCTAssertEqual(reads, 2)
    }

    func testTheNewNumberShowsAloneWhileTheOldSituationWaits() throws {
        let old = try decode(#"{"state":"1","evaluated_at":"2026-11-07T11:50:00Z","sentence":"Glukoza jest w zakresie.","glucose":{"value":110,"at":"2026-11-07T11:50:00Z","tone":"NEUTRAL"}}"#)
        func early(_ value: Int, at: String) -> NowSituationDisplay {
            NowSituation.display(situation: old, glucose: nil, freshness: .refreshing, readFailed: false, lastSuccessAt: nil, now: now,
                                 earlyGlucose: DashboardGlucose(value: value, unit: "mg/dL", direction: "Flat", observed_at: at, delta: 2))
        }
        let shown = try XCTUnwrap(early(64, at: "2026-11-07T11:59:00Z").situation)
        XCTAssertTrue(shown.isEarly)
        XCTAssertEqual(shown.glucose?.value, 64)
        XCTAssertEqual(shown.glucose?.tone, "RED")
        XCTAssertEqual(shown.sentence, "")
        XCTAssertNil(shown.action)
        XCTAssertNil(shown.second)
        XCTAssertNil(shown.link, "no button before the whole read")
        XCTAssertEqual(early(200, at: "2026-11-07T11:58:00Z").situation?.glucose?.tone, "AMBER")
        XCTAssertEqual(early(120, at: "2026-11-07T11:54:00Z"), .waiting, "a reading over 5 minutes old waits for the whole read")
        XCTAssertEqual(NowSituation.display(situation: old, glucose: nil, freshness: .fresh, readFailed: false, lastSuccessAt: now, now: now,
                                            earlyGlucose: DashboardGlucose(value: 64, unit: "mg/dL", direction: nil, observed_at: "2026-11-07T11:59:00Z", delta: nil)).situation?.isEarly, false,
                       "once the whole read is in, its situation")
    }

    @MainActor
    func testAfterABreakTheNewestReadingComesAheadOfTheDashboard() async throws {
        var clock = now
        var base = DashboardResponse(patient_id: "p", generated_at: "2026-11-07T12:00:00Z",
                                     glucose: DashboardGlucose(value: 110, unit: "mg/dL", direction: "Flat", observed_at: "2026-11-07T11:59:00Z", delta: 0),
                                     readings: [], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        let held = AsyncStream<Void>.makeStream()
        var reads = 0
        var glucoseReads = 0
        let viewModel = DashboardViewModel(patientID: "p", fetch: { _ in
            reads += 1
            if reads > 1 { for await _ in held.stream { break } }
            return base
        }, clock: { clock })
        let newest = DashboardGlucose(value: 64, unit: "mg/dL", direction: "SingleDown", observed_at: "2026-11-07T12:09:30Z", delta: -8)
        viewModel.setGlucoseFirst { _ in
            glucoseReads += 1
            return newest
        }
        await viewModel.refresh()
        XCTAssertEqual(glucoseReads, 0, "a fresh screen reads only the dashboard")

        clock = now.addingTimeInterval(10 * 60)
        viewModel.markStaleIfInactive()
        XCTAssertEqual(viewModel.freshness, .refreshing)
        let read = Task { await viewModel.refresh() }
        for _ in 0..<50 where viewModel.earlyGlucose == nil { await Task.yield() }
        XCTAssertEqual(viewModel.earlyGlucose, newest)
        XCTAssertEqual(viewModel.freshness, .refreshing)

        base = DashboardResponse(patient_id: "p", generated_at: "2026-11-07T12:10:00Z", glucose: newest,
                                 readings: [], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        held.continuation.yield()
        _ = await read.value
        XCTAssertNil(viewModel.earlyGlucose, "the dashboard's own read takes over")
        XCTAssertEqual(viewModel.freshness, .fresh)
        XCTAssertEqual(glucoseReads, 1)
    }

    @MainActor
    func testAnEarlyReadingNoNewerThanTheScreenIsNotKept() async throws {
        var clock = now
        let base = DashboardResponse(patient_id: "p", generated_at: "2026-11-07T12:00:00Z",
                                     glucose: DashboardGlucose(value: 110, unit: "mg/dL", direction: "Flat", observed_at: "2026-11-07T11:59:00Z", delta: 0),
                                     readings: [], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        let held = AsyncStream<Void>.makeStream()
        var reads = 0
        var glucoseReads = 0
        let viewModel = DashboardViewModel(patientID: "p", fetch: { _ in
            reads += 1
            if reads > 1 { for await _ in held.stream { break } }
            return base
        }, clock: { clock })
        viewModel.setGlucoseFirst { _ in
            glucoseReads += 1
            if glucoseReads == 1 { throw URLError(.badServerResponse) }
            return base.glucose
        }
        await viewModel.refresh()
        clock = now.addingTimeInterval(10 * 60)
        viewModel.markStaleIfInactive()
        let read = Task { await viewModel.refresh() }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(glucoseReads, 1)
        XCTAssertNil(viewModel.earlyGlucose, "an older server without the route: the screen waits as before")
        held.continuation.yield()
        _ = await read.value
        XCTAssertEqual(viewModel.freshness, .fresh)
    }

    @MainActor
    func testGivenCarbsShowTheUndoWindowAtOnceAndReadInTheBackground() async throws {
        let situation = try decode(#"{"state":"5","evaluated_at":"2026-11-07T12:00:00Z","glucose":{"value":90,"at":"2026-11-07T11:59:00Z","tone":"NEUTRAL"},"sentence":"Glukoza może wkrótce spaść poniżej 70."}"#)
        var base = DashboardResponse(patient_id: "p", generated_at: "2026-11-07T12:00:00Z", glucose: nil, readings: [], time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil)
        base.situation = situation
        let held = AsyncStream<Void>.makeStream()
        var reads = 0
        let viewModel = DashboardViewModel(patientID: "p", fetch: { _ in
            reads += 1
            if reads > 1 { for await _ in held.stream { break } }
            return base
        }, clock: { self.now })
        await viewModel.refresh()
        viewModel.setSituationActions(log: { _, _ in SituationCarbsResponse(status: "LOGGED", event_id: "e1") }, undo: { _, _ in SituationCarbsResponse(status: "UNDONE") })
        let done = await viewModel.logGivenCarbs(3)
        XCTAssertTrue(done)
        let shown = try XCTUnwrap(viewModel.dashboard?.situation)
        XCTAssertEqual(shown.state, "8u")
        XCTAssertEqual(shown.action?.event_id, "e1")
        XCTAssertEqual(shown.second?.value, "3 g")
        XCTAssertEqual(shown.glucose?.value, 90)
        XCTAssertEqual(shown.undoSecondsLeft(now: now), 5)
        held.continuation.finish()
    }

    private var pushInfo: [AnyHashable: Any] {
        ["gluco": ["type": "rescue_carbs", "patientId": "11111111-1111-4111-8111-111111111111", "conversationId": "22222222-2222-4222-8222-222222222222", "alertId": "a",
                   "routePath": "/patients/11111111-1111-4111-8111-111111111111/conversations/22222222-2222-4222-8222-222222222222",
                   "situationAlertAt": "2026-11-07T11:36:00.000Z", "situationGlucose": "68", "situationGrams": "5"] as [String: Any]]
    }

    func testARescuePushOpensTerazOnlyWithTheNewField() {
        XCTAssertEqual(AppRoute.parse(pushPayload: pushInfo), .patient(patientID: "11111111-1111-4111-8111-111111111111"))
        var old = pushInfo["gluco"] as! [String: Any]
        old.removeValue(forKey: "situationAlertAt")
        guard case .conversation = AppRoute.parse(pushPayload: ["gluco": old]) else { return XCTFail("old pushes keep the conversation") }
    }

    func testTheAlertHasPassedLineStandsForAMinuteOnlyWhenItPassed() throws {
        let context = try XCTUnwrap(SituationPushContext.parse(userInfo: pushInfo, openedAt: now))
        let warsaw = TimeZone(identifier: "Europe/Warsaw")!
        let calm = try decode(#"{"state":"1d","sentence":"x","glucose":{"value":84,"at":"2026-11-07T11:59:00Z","tone":"NEUTRAL"}}"#)
        XCTAssertEqual(context.staleLine(situation: calm, delta: 2, now: now, timeZone: warsaw), "Alert z 12:36 jest już nieaktualny.")
        XCTAssertNil(context.staleLine(situation: calm, delta: 2, now: now.addingTimeInterval(61), timeZone: warsaw))
        let low = try decode(#"{"state":"6","sentence":"x","glucose":{"value":66,"at":"2026-11-07T11:59:00Z","tone":"RED"}}"#)
        XCTAssertNil(context.staleLine(situation: low, delta: -2, now: now, timeZone: warsaw))
    }

    func testOfflineShowsOnlyThePushsOwnWordsWithNoAction() throws {
        let context = try XCTUnwrap(SituationPushContext.parse(userInfo: pushInfo, openedAt: now))
        let offline = try XCTUnwrap(context.offlineSituation(now: now, timeZone: TimeZone(identifier: "Europe/Warsaw")!))
        XCTAssertEqual(offline.sentence, "Nie udało się pobrać danych.")
        XCTAssertEqual(offline.detail, "Alert z 12:36: glukoza 68, propozycja 5 g.")
        XCTAssertNil(offline.action)
        XCTAssertEqual(offline.glucose?.tone, "STALE")
        XCTAssertTrue(offline.isUsable(now: now))
        XCTAssertNil(context.offlineSituation(now: now.addingTimeInterval(16 * 60)))
    }

    func testRedOnlyBelow54() throws {
        XCTAssertTrue(try decode(#"{"state":"7","sentence":"x","glucose":{"value":48,"at":"2026-11-07T11:59:00Z","tone":"ON_RED"}}"#).isUrgentRed)
        XCTAssertFalse(try decode(#"{"state":"6","sentence":"x","glucose":{"value":66,"at":"2026-11-07T11:59:00Z","tone":"RED"}}"#).isUrgentRed)
    }
}

final class DayLineRotationTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "rotation-\(UUID().uuidString)"
        return UserDefaults(suiteName: name)!
    }

    func testKeepsALineForAnHourThenTakesTheNext() {
        let rotation = DayLineRotation(scope: "p", defaults: defaults())
        let start = Date(timeIntervalSince1970: 1_000_000)
        let first = rotation.line(lines: ["a", "b"], state: "1d", now: start)
        XCTAssertEqual(first, "a")
        XCTAssertEqual(rotation.line(lines: ["a", "b"], state: "1d", now: start.addingTimeInterval(3_599)), "a")
        XCTAssertEqual(rotation.line(lines: ["a", "b"], state: "1d", now: start.addingTimeInterval(3_600)), "b")
    }

    func testAChangedSituationTakesTheNextLineAtOnce() {
        let rotation = DayLineRotation(scope: "p", defaults: defaults())
        let start = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(rotation.line(lines: ["a", "b"], state: "1d", now: start), "a")
        XCTAssertEqual(rotation.line(lines: ["a", "b"], state: "2", now: start.addingTimeInterval(1)), "b")
    }

    func testNoLinesNoLine() {
        XCTAssertNil(DayLineRotation(scope: "p", defaults: defaults()).line(lines: [], state: "1d", now: Date()))
    }

    func testNoHangingWordsAtTheEndOfALine() {
        let nbsp = "\u{00A0}"
        XCTAssertEqual(NowSituation.noBreaks("Glukoza spada, a Trio działa od 25 minut."), "Glukoza spada, a\(nbsp)Trio działa od\(nbsp)25\(nbsp)minut.")
        XCTAssertEqual(NowSituation.noBreaks("Na razie w Trio"), "Na\(nbsp)razie w\(nbsp)Trio")
    }

    func testUndoSentenceKeepsWhoGaveTheCarbs() {
        XCTAssertEqual(NowSituation.undoSentence(seconds: 3, serverSentence: "Opiekun Ewa podał węgle. Mellis zapisze je za 5 sekund."), "Opiekun Ewa podał węgle. Mellis zapisze je za 3 sekundy.")
        XCTAssertEqual(NowSituation.undoSentence(seconds: 4, serverSentence: "Ewa podała węgle. Mellis zapisze je za 5 sekund."), "Ewa podała węgle. Mellis zapisze je za 4 sekundy.")
    }
}

final class SituationAgedOutTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func situation(value: Int, minutesOld: Double, state: String = "6", tone: String = "RED") -> NowSituation {
        let formatter = ISO8601DateFormatter()
        return NowSituation(
            state: state,
            evaluated_at: formatter.string(from: now),
            glucose: .init(value: value, at: formatter.string(from: now.addingTimeInterval(-minutesOld * 60)), tone: tone),
            second: .init(kind: "DOSE", label: "Podaj", value: "3 g", unit: "szybkich węgli", note: nil),
            sentence: "Glukoza jest poniżej 70.",
            detail: nil,
            action: .init(kind: "GIVEN", grams: 3, style: "FILLED", label: "Podano 3 g", other_amount_label: "Inna ilość", event_id: nil, until: nil),
            check: nil
        )
    }

    func testAnOldLowLosesItsDoseAfterFifteenMinutesToo() {
        XCTAssertEqual(situation(value: 66, minutesOld: 14).agedOut(now: now).state, "6")
        let old = situation(value: 66, minutesOld: 15).agedOut(now: now)
        XCTAssertEqual(old.state, "9b")
        XCTAssertEqual(old.sentence, "Zmierz glukozę glukometrem.")
        XCTAssertEqual(old.second?.kind, "NO_READING")
        XCTAssertNil(old.action)
        XCTAssertFalse(old.showsDose)
    }

    func testAnyOtherReadingGoesAfterFifteenMinutes() {
        XCTAssertEqual(situation(value: 128, minutesOld: 14, state: "1d", tone: "NEUTRAL").agedOut(now: now).state, "1d")
        let old = situation(value: 128, minutesOld: 15, state: "1d", tone: "NEUTRAL").agedOut(now: now, loopSystem: .loop)
        XCTAssertEqual(old.state, "9")
        XCTAssertEqual(old.sentence, "Warto sprawdzić sensor i telefon z Loopem.")
        XCTAssertNil(old.detail)
        XCTAssertEqual(old.glucose?.tone, "STALE")
        XCTAssertNil(old.action)
    }

    func testTheUndoWindowStays() {
        XCTAssertEqual(situation(value: 66, minutesOld: 20, state: "8u").agedOut(now: now).state, "8u")
    }
}
