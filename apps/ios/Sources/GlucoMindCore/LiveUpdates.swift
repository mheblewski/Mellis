import Combine
import Foundation
import SwiftUI

/// A change another caregiver (or the server) made that a screen may be showing.
public enum LiveChange: Equatable {
    /// kind: conversation, meal, meals, meal_chat, loop_action, hypo, notifications; id: the conversation or meal.
    case changed(kind: String, id: String?)
    /// Changes may have been missed while disconnected: re-read everything shown.
    case resync

    public func concerns(kind: String, id: String? = nil) -> Bool {
        switch self {
        case .resync:
            return true
        case let .changed(changedKind, changedID):
            return changedKind == kind && (id == nil || changedID == nil || changedID == id?.lowercased())
        }
    }

    public func concerns(anyOf kinds: Set<String>) -> Bool {
        switch self {
        case .resync:
            return true
        case let .changed(kind, _):
            return kinds.contains(kind)
        }
    }
}

/// Live updates of one patient while the app is in the foreground (live-updates.v1): one event stream, reconnected with
/// backoff. Screens subscribe to `changes` and re-read what they show, and read answers being written from `drafts`.
/// While `isLive` is false they keep their own polling.
@MainActor
public final class LiveUpdates: ObservableObject {
    @Published public private(set) var isLive = false
    @Published public private(set) var drafts: [ReplyDraftKey: LiveReplyDraft] = [:]
    public let changes = PassthroughSubject<LiveChange, Never>()

    public let patientID: String
    private let requestFactory: () async throws -> URLRequest
    private let transport: EventStreamTransport
    private let retryDelays: [Duration]
    /// No line (not even the server's 15 s heartbeat) for this long: the connection is dead, reconnect.
    private let idleTimeout: Duration
    private var accumulator = ReplyDraftAccumulator()
    private var connectionTask: Task<Void, Never>?
    private var connectedBefore = false

    public init(patientID: String, api: APIClient, transport: EventStreamTransport = URLSessionEventStreamTransport()) {
        self.patientID = patientID
        self.requestFactory = { try await api.liveEventsRequest(patientID: patientID) }
        self.transport = transport
        self.retryDelays = [.seconds(1), .seconds(2), .seconds(5), .seconds(10), .seconds(30)]
        self.idleTimeout = Self.defaultIdleTimeout
    }

    /// Tests: a request factory and short retry delays (and idle timeout).
    public init(patientID: String, requestFactory: @escaping () async throws -> URLRequest, transport: EventStreamTransport, retryDelays: [Duration],
                idleTimeout: Duration = LiveUpdates.defaultIdleTimeout) {
        self.patientID = patientID
        self.requestFactory = requestFactory
        self.transport = transport
        self.retryDelays = retryDelays.isEmpty ? [.seconds(1)] : retryDelays
        self.idleTimeout = idleTimeout
    }

    /// Three of the server's 15 s heartbeats (live-events.service.ts HEARTBEAT_MS).
    nonisolated public static let defaultIdleTimeout: Duration = .seconds(45)

    deinit {
        connectionTask?.cancel()
    }

    public func draft(_ key: ReplyDraftKey) -> LiveReplyDraft? {
        drafts[key]
    }

    /// Opens the stream (foreground); idempotent.
    public func start() {
        guard connectionTask == nil else { return }
        connectionTask = Task { [weak self] in
            await self?.run()
        }
    }

    /// Closes the stream (background, patient switch, sign-out).
    public func stop() {
        connectionTask?.cancel()
        connectionTask = nil
        setDisconnected()
    }

    private func run() async {
        var failures = 0
        while !Task.isCancelled {
            var opened = false
            do {
                let request = try await requestFactory()
                // A connection that died without closing (the phone suspended with the stream open, a network switch)
                // never ends by itself: without this the stream looked live forever and nothing re-read after it.
                let lines = LiveStreamWatchdog.guarding(try await transport.lines(for: request), idle: idleTimeout)
                var parser = ServerSentEventParser()
                for try await line in lines {
                    if Task.isCancelled { break }
                    guard let frame = parser.consume(line), let event = LiveEvent(frame) else { continue }
                    if case .ready = event {
                        opened = true
                        failures = 0
                    }
                    handle(event)
                }
            } catch {
                if Task.isCancelled { break }
                // Access was refused: no point in retrying quickly.
                if let apiError = error as? APIClientError, case .forbidden = apiError {
                    failures = retryDelays.count
                }
            }
            // stop() already reset the state; a newer connection may be running by now.
            if Task.isCancelled { break }
            setDisconnected()
            // A stream the server closed after it was open (maximum age) reconnects at once with a fresh token.
            if !opened {
                failures += 1
                let delay = retryDelays[min(failures, retryDelays.count) - 1]
                try? await Task.sleep(for: delay)
            }
        }
    }

    func handle(_ event: LiveEvent) {
        switch event {
        case let .ready(live):
            isLive = live
            if connectedBefore {
                changes.send(.resync)
            }
            connectedBefore = true
        case .resync:
            // Also sent when the server's database connection comes (back) up: it delivers events again.
            isLive = true
            accumulator.clearAll()
            drafts = accumulator.drafts
            changes.send(.resync)
        case let .change(kind, id):
            changes.send(.changed(kind: kind, id: id))
        case let .draft(key, replyTo, offset, delta):
            switch accumulator.apply(key: key, replyTo: replyTo, offset: offset, delta: delta) {
            case .updated:
                drafts = accumulator.drafts
            case .unchanged:
                break
            case .outOfStep:
                drafts = accumulator.drafts
                changes.send(.changed(kind: key.thread == .conversation ? "conversation" : "meal_chat", id: key.id))
            }
        case let .draftCleared(key):
            if accumulator.clear(key) {
                drafts = accumulator.drafts
            }
        }
    }

    private func setDisconnected() {
        if isLive { isLive = false }
        accumulator.clearAll()
        if !drafts.isEmpty { drafts = [:] }
    }
}

/// Ends a stream with `LiveStreamIdle` when it yields nothing for `idle` (the server's heartbeats are lines too).
public enum LiveStreamWatchdog {
    public struct LiveStreamIdle: Error, Equatable {}

    public static func guarding(_ lines: AsyncThrowingStream<String, Error>, idle: Duration) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let ticks = Ticks()
            let reader = Task {
                do {
                    for try await line in lines {
                        ticks.bump()
                        continuation.yield(line)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            let watchdog = Task {
                var seen = ticks.value
                while !Task.isCancelled {
                    try? await Task.sleep(for: idle)
                    if Task.isCancelled { return }
                    let now = ticks.value
                    if now == seen {
                        continuation.finish(throwing: LiveStreamIdle())
                        reader.cancel()
                        return
                    }
                    seen = now
                }
            }
            continuation.onTermination = { _ in
                reader.cancel()
                watchdog.cancel()
            }
        }
    }

    private final class Ticks: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func bump() { lock.withLock { count += 1 } }
    }
}

private struct LiveUpdatesKey: EnvironmentKey {
    static let defaultValue: LiveUpdates? = nil
}

public extension EnvironmentValues {
    /// The live updates of the selected patient; nil before a patient is selected and in previews.
    var liveUpdates: LiveUpdates? {
        get { self[LiveUpdatesKey.self] }
        set { self[LiveUpdatesKey.self] = newValue }
    }
}
