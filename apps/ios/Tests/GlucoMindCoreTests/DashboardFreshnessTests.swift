import Combine
import XCTest
@testable import GlucoMindCore

/// stale-ui.v1 (2026-10-31): the dashboard after a return to the foreground: stale → refreshing → fresh or failed, one
/// threshold, retries with backoff, a timeout for a dead connection, and never two reads at once.
@MainActor
final class DashboardFreshnessTests: XCTestCase {
    private let patientID = "11111111-1111-4111-8111-111111111111"
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    /// Reads the test answers one by one; `hold` keeps a read waiting until `release`.
    private final class FakeServer {
        enum Answer { case ok, fail, hang }
        var answers: [Answer] = []
        var calls = 0
        var cancelled = 0
        var held: [CheckedContinuation<Void, Never>] = []
        var holds = false
        let dashboard: DashboardResponse

        init(dashboard: DashboardResponse) { self.dashboard = dashboard }

        func fetch() async throws -> DashboardResponse {
            calls += 1
            if holds {
                await withCheckedContinuation { held.append($0) }
            }
            switch answers.isEmpty ? .ok : answers.removeFirst() {
            case .ok: return dashboard
            case .fail: throw APIClientError.transport("offline")
            case .hang:
                do {
                    try await Task.sleep(for: .seconds(30))
                } catch {
                    cancelled += 1
                    throw error
                }
                return dashboard
            }
        }

        func release() {
            holds = false
            let waiting = held
            held = []
            waiting.forEach { $0.resume() }
        }
    }

    private final class Clock {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    private func makeDashboard() -> DashboardResponse {
        let iso = ISO8601DateFormatter()
        return DashboardResponse(
            patient_id: patientID, generated_at: iso.string(from: start),
            glucose: DashboardGlucose(value: 124, unit: "mg/dL", direction: "Flat", observed_at: iso.string(from: start.addingTimeInterval(-120)), delta: 1),
            readings: [DashboardReading(at: iso.string(from: start.addingTimeInterval(-120)), value: 124)],
            time_in_range: nil, pump: nil, site_changed_at: nil, sensor_started_at: nil
        )
    }

    private func makeModel(_ server: FakeServer, clock: Clock, timeout: Duration = .seconds(5)) -> DashboardViewModel {
        DashboardViewModel(
            patientID: patientID,
            fetch: { _ in try await server.fetch() },
            clock: { clock.now },
            retryDelays: [.milliseconds(10), .milliseconds(20)],
            requestTimeout: timeout
        )
    }

    private func waitUntil(_ condition: @autoclosure () -> Bool, timeout: Duration = .seconds(2)) async {
        let deadline = ContinuousClock.now + timeout
        while !condition(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func testTheThresholdIsOneConstantBetweenOneAndTwoMinutes() {
        XCTAssertGreaterThanOrEqual(DashboardViewModel.inactivityThreshold, 60)
        XCTAssertLessThanOrEqual(DashboardViewModel.inactivityThreshold, 120)
    }

    func testAReturnAfterInactivityDimsAtOnceThenTurnsFreshWhenTheReadArrives() async {
        let server = FakeServer(dashboard: makeDashboard())
        let clock = Clock(start)
        let model = makeModel(server, clock: clock)
        await model.refresh()
        XCTAssertEqual(model.freshness, .fresh)

        clock.now = start.addingTimeInterval(DashboardViewModel.inactivityThreshold + 30)
        server.holds = true
        let loop = Task { await model.run() }
        await waitUntil(server.held.count == 1)
        // The old data is still on screen, dimmed, with the spinner, while the read runs.
        XCTAssertEqual(model.freshness, .refreshing)
        XCTAssertTrue(model.freshness.dimsGlucose)
        XCTAssertNotNil(model.dashboard)

        server.release()
        await waitUntil(model.freshness == .fresh)
        XCTAssertEqual(model.freshness, .fresh)
        XCTAssertEqual(model.lastSuccessAt, clock.now)
        loop.cancel()
    }

    func testAShortAbsenceDoesNotDim() async {
        let server = FakeServer(dashboard: makeDashboard())
        let clock = Clock(start)
        let model = makeModel(server, clock: clock)
        await model.refresh()

        clock.now = start.addingTimeInterval(DashboardViewModel.inactivityThreshold - 10)
        var seen: [DashboardFreshness] = []
        let sink = model.$freshness.sink { seen.append($0) }
        await model.refreshAfterReturn()
        XCTAssertEqual(seen, [.fresh], "a quick tab switch never flashes the dimmed look")
        sink.cancel()
    }

    func testAFailedReadAfterAReturnStaysDimmedAndIsRetriedWithBackoff() async {
        let server = FakeServer(dashboard: makeDashboard())
        let clock = Clock(start)
        let model = makeModel(server, clock: clock)
        await model.refresh()

        clock.now = start.addingTimeInterval(300)
        server.answers = [.fail, .fail, .ok]
        var seen: [DashboardFreshness] = []
        let sink = model.$freshness.removeDuplicates().sink { seen.append($0) }
        let loop = Task { await model.run() }
        await waitUntil(server.calls >= 4 && model.freshness == .fresh)
        loop.cancel()

        XCTAssertEqual(seen, [.fresh, .refreshing, .failed, .fresh])
        XCTAssertEqual(server.calls, 4, "the first read, two quick retries, then the one that worked")
        XCTAssertNil(model.errorMessage)
        sink.cancel()
    }

    func testTheFailureMessageAndRetryNowShowTheSpinnerAgain() async {
        let server = FakeServer(dashboard: makeDashboard())
        let clock = Clock(start)
        let model = makeModel(server, clock: clock)
        await model.refresh()
        clock.now = start.addingTimeInterval(300)
        server.answers = [.fail]
        await model.refreshAfterReturn()
        XCTAssertEqual(model.freshness, .failed)
        XCTAssertEqual(model.errorMessage, DashboardViewModel.failureMessage)
        XCTAssertNotNil(model.dashboard, "the last data stays on screen")

        server.holds = true
        let retry = Task { await model.retryNow() }
        await waitUntil(server.held.count == 1)
        XCTAssertEqual(model.freshness, .refreshing)
        server.release()
        await retry.value
        XCTAssertEqual(model.freshness, .fresh)
        XCTAssertNil(model.errorMessage)
    }

    func testReadsAskedForWhileOneRunsJoinIt() async {
        let server = FakeServer(dashboard: makeDashboard())
        let clock = Clock(start)
        let model = makeModel(server, clock: clock)
        server.holds = true

        // The tab's loop, the foreground notification, the live stream's resync and a pull, all at once.
        let loop = Task { await model.run() }
        let foreground = Task { await model.refreshAfterReturn() }
        let resync = Task { await model.refreshAfterReturn() }
        let pull = Task { await model.refreshFromPull() }
        await waitUntil(server.held.count == 1)
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(server.held.count, 1)

        server.release()
        await foreground.value
        await resync.value
        await pull.value
        XCTAssertEqual(server.calls, 1)
        XCTAssertEqual(model.loadCount, 1)
        XCTAssertNotNil(model.dashboard)
        loop.cancel()
    }

    func testAReadThatHangsGivesUpAfterTheTimeout() async {
        let server = FakeServer(dashboard: makeDashboard())
        let clock = Clock(start)
        let model = makeModel(server, clock: clock, timeout: .milliseconds(50))
        await model.refresh()
        clock.now = start.addingTimeInterval(300)
        server.answers = [.hang]

        let began = ContinuousClock.now
        let succeeded = await model.refresh()
        XCTAssertFalse(succeeded)
        XCTAssertLessThan(ContinuousClock.now - began, .seconds(2), "not URLSession's default minute")
        XCTAssertEqual(server.cancelled, 1, "the hanging request is cancelled")
        XCTAssertEqual(model.errorMessage, DashboardViewModel.failureMessage)
        XCTAssertEqual(model.freshness, .failed, "the data is over the threshold old: dimmed")
    }

    func testLeavingTheTabOrTheForegroundCancelsTheReadWithoutAnError() async {
        let server = FakeServer(dashboard: makeDashboard())
        let clock = Clock(start)
        let model = makeModel(server, clock: clock)
        await model.refresh()
        server.answers = [.hang]

        let loop = Task { await model.run() }
        await waitUntil(server.calls == 2)
        loop.cancel()
        await waitUntil(server.cancelled == 1)
        XCTAssertEqual(server.cancelled, 1)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.freshness, .fresh)
        XCTAssertFalse(model.isLoading)
    }
}

/// The live stream's watchdog: a connection silent for longer than three heartbeats is dropped and reopened, and the
/// reopened stream asks the screens (the dashboard too) to re-read.
@MainActor
final class LiveStreamWatchdogTests: XCTestCase {
    /// Each connection says "ready" and then nothing, never closing (a connection that died while suspended).
    private final class SilentAfterReady: EventStreamTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var opened: Int { lock.withLock { count } }

        func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
            lock.withLock { count += 1 }
            return AsyncThrowingStream { continuation in
                for line in ["event: ready", #"data: {"live":true}"#, ""] { continuation.yield(line) }
            }
        }
    }

    func testASilentStreamIsReopenedAndAsksForAResync() async throws {
        let transport = SilentAfterReady()
        let live = LiveUpdates(
            patientID: "p",
            requestFactory: { URLRequest(url: URL(string: "https://api.example.com/v1/patients/p/events")!) },
            transport: transport,
            retryDelays: [.milliseconds(5)],
            idleTimeout: .milliseconds(40)
        )
        var changes: [LiveChange] = []
        let sink = live.changes.sink { changes.append($0) }
        live.start()
        for _ in 0..<200 where changes.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        live.stop()
        sink.cancel()
        XCTAssertGreaterThanOrEqual(transport.opened, 2)
        XCTAssertEqual(changes.first, .resync)
    }

    func testHeartbeatsKeepTheStreamOpen() async throws {
        let source = AsyncThrowingStream<String, Error> { continuation in
            Task {
                for _ in 0..<8 {
                    continuation.yield(":")
                    try? await Task.sleep(for: .milliseconds(10))
                }
                continuation.finish()
            }
        }
        var lines = 0
        for try await _ in LiveStreamWatchdog.guarding(source, idle: .milliseconds(60)) {
            lines += 1
        }
        XCTAssertEqual(lines, 8)
    }

    func testSilenceEndsTheStreamWithAnError() async {
        let source = AsyncThrowingStream<String, Error> { continuation in
            continuation.yield("event: ready")
        }
        do {
            for try await _ in LiveStreamWatchdog.guarding(source, idle: .milliseconds(30)) {}
            XCTFail("expected the idle error")
        } catch {
            XCTAssertEqual(error as? LiveStreamWatchdog.LiveStreamIdle, LiveStreamWatchdog.LiveStreamIdle())
        }
    }
}
