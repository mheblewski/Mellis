import Foundation

/// One Server-Sent Events frame: the `event:` name and its `data:` lines joined.
public struct ServerSentEvent: Equatable {
    public let event: String
    public let data: String
}

/// Turns the lines of a text/event-stream into frames. Comment lines (heartbeats) and `retry:`/`id:` are skipped; a
/// frame ends at a blank line.
public struct ServerSentEventParser {
    private var event = ""
    private var dataLines: [String] = []

    public init() {}

    public mutating func consume(_ line: String) -> ServerSentEvent? {
        if line.isEmpty {
            defer {
                event = ""
                dataLines = []
            }
            guard !dataLines.isEmpty || !event.isEmpty else { return nil }
            return ServerSentEvent(event: event.isEmpty ? "message" : event, data: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") {
            return nil
        }
        let (field, value) = Self.split(line)
        switch field {
        case "event":
            event = value
        case "data":
            dataLines.append(value)
        default:
            break
        }
        return nil
    }

    private static func split(_ line: String) -> (String, String) {
        guard let colon = line.firstIndex(of: ":") else { return (line, "") }
        var value = line[line.index(after: colon)...]
        if value.first == " " { value = value.dropFirst() }
        return (String(line[..<colon]), String(value))
    }
}

/// The thread an answer is written in: a conversation or a meal chat (its meal id).
public enum ReplyDraftThread: String, Codable, Hashable {
    case conversation
    case mealChat = "meal_chat"
}

public struct ReplyDraftKey: Hashable {
    public let thread: ReplyDraftThread
    public let id: String

    public init(thread: ReplyDraftThread, id: String) {
        self.thread = thread
        self.id = id.lowercased()
    }
}

/// The answer text written so far to one caregiver message.
public struct LiveReplyDraft: Equatable, Codable {
    public let reply_to_message_id: String
    public let content: String

    public init(reply_to_message_id: String, content: String) {
        self.reply_to_message_id = reply_to_message_id
        self.content = content
    }
}

/// What the server streams (live-updates.v1).
public enum LiveEvent: Equatable {
    /// The connection is open; `live` is false while the server has lost its database connection.
    case ready(live: Bool)
    /// Something of this kind changed (conversation, meal, meals, meal_chat, loop_action, hypo, notifications).
    case change(kind: String, id: String?)
    /// Part of an answer: append `delta` at `offset` (0 replaces the text).
    case draft(key: ReplyDraftKey, replyTo: String, offset: Int, delta: String)
    case draftCleared(key: ReplyDraftKey)
    /// Events may have been missed: re-read everything shown.
    case resync

    public init?(_ frame: ServerSentEvent) {
        let data = Data(frame.data.utf8)
        switch frame.event {
        case "ready":
            let payload = try? JSONDecoder().decode(ReadyPayload.self, from: data)
            self = .ready(live: payload?.live ?? true)
        case "resync":
            self = .resync
        case "change":
            guard let payload = try? JSONDecoder().decode(ChangePayload.self, from: data) else { return nil }
            self = .change(kind: payload.kind, id: payload.id?.lowercased())
        case "draft":
            guard let payload = try? JSONDecoder().decode(DraftPayload.self, from: data) else { return nil }
            let key = ReplyDraftKey(thread: payload.thread, id: payload.id)
            if payload.cleared == true {
                self = .draftCleared(key: key)
            } else if let replyTo = payload.reply_to, let offset = payload.offset, let delta = payload.delta {
                self = .draft(key: key, replyTo: replyTo.lowercased(), offset: offset, delta: delta)
            } else {
                return nil
            }
        default:
            return nil
        }
    }

    private struct ReadyPayload: Decodable { let live: Bool? }
    private struct ChangePayload: Decodable { let kind: String; let id: String? }
    private struct DraftPayload: Decodable {
        let thread: ReplyDraftThread
        let id: String
        let reply_to: String?
        let offset: Int?
        let delta: String?
        let cleared: Bool?
    }
}

/// Rebuilds drafts from delta frames. A frame that does not fit the text held (one was missed) drops the draft and
/// reports it, so the screen re-reads the thread instead of showing broken text.
public struct ReplyDraftAccumulator {
    public private(set) var drafts: [ReplyDraftKey: LiveReplyDraft] = [:]

    public init() {}

    public enum Outcome: Equatable {
        case updated
        case unchanged
        case outOfStep
    }

    public mutating func apply(key: ReplyDraftKey, replyTo: String, offset: Int, delta: String) -> Outcome {
        if offset == 0 {
            let draft = LiveReplyDraft(reply_to_message_id: replyTo, content: delta)
            guard drafts[key] != draft else { return .unchanged }
            drafts[key] = draft
            return .updated
        }
        guard let current = drafts[key], current.reply_to_message_id == replyTo, current.content.utf16.count == offset else {
            drafts[key] = nil
            return .outOfStep
        }
        guard !delta.isEmpty else { return .unchanged }
        drafts[key] = LiveReplyDraft(reply_to_message_id: replyTo, content: current.content + delta)
        return .updated
    }

    public mutating func clear(_ key: ReplyDraftKey) -> Bool {
        drafts.removeValue(forKey: key) != nil
    }

    public mutating func clearAll() {
        drafts = [:]
    }
}

/// Opens a text/event-stream and yields its lines. A non-2xx answer throws the same errors as the JSON endpoints.
public protocol EventStreamTransport {
    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error>
}

public struct URLSessionEventStreamTransport: EventStreamTransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionEventStreamTransport.makeSession()) {
        self.session = session
    }

    /// No caching and no waiting for connectivity: a dropped stream should fail fast and reconnect.
    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        return URLSession(configuration: configuration)
    }

    public func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count > 16_384 { break }
            }
            throw APIClient.error(status: http.statusCode, body: body) ?? APIClientError.invalidResponse
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // AsyncLineSequence drops empty lines, which end SSE frames: read bytes and split on newlines.
                    var line = Data()
                    for try await byte in bytes {
                        if byte == UInt8(ascii: "\n") {
                            if line.last == UInt8(ascii: "\r") { line.removeLast() }
                            continuation.yield(String(decoding: line, as: UTF8.self))
                            line.removeAll(keepingCapacity: true)
                        } else {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
