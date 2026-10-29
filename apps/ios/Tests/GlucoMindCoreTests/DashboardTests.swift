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
