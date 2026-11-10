import Foundation

public enum DiagnosticCategory: String, Codable {
    case app, network, push, remote, keychain, crash
}

public struct DiagnosticEntry: Codable, Equatable {
    public let at: Date
    public let category: DiagnosticCategory
    public let event: String
    public let fields: [String: String]

    public init(at: Date, category: DiagnosticCategory, event: String, fields: [String: String]) {
        self.at = at
        self.category = category
        self.event = event
        self.fields = fields
    }
}

/// What may enter the phone's diagnostic log (diagnostics.v1). The report can be published in a GitHub issue, so a value
/// must have the shape of a constant from code: a sentence, an address, an e-mail or an identifier is dropped.
public enum DiagnosticSanitizer {
    private static let code = try! NSRegularExpression(pattern: "^-?[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
    private static let route = try! NSRegularExpression(pattern: "^/[A-Za-z0-9_/:.-]{0,159}$")
    private static let identifier = try! NSRegularExpression(pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}|[0-9]{9,}")

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    public static func isCode(_ value: String) -> Bool {
        matches(code, value) && !matches(identifier, value)
    }

    /// Only the fields that pass. `route` holds a template from `routeTemplate`, every other field a code.
    public static func fields(_ raw: [String: String]) -> [String: String] {
        raw.filter { key, value in
            guard isCode(key) else { return false }
            return key == "route" ? matches(route, value) && !matches(identifier, value) : isCode(value)
        }
    }

    /// The path of a request without its identifiers and query: "/v1/patients/:id/meals/:id".
    public static func routeTemplate(_ url: URL?) -> String {
        guard let path = url?.path, !path.isEmpty else { return "/" }
        let segments = path.split(separator: "/").map { segment -> String in
            let text = String(segment)
            let isVersion = text.first == "v" && text.dropFirst().allSatisfy(\.isNumber) && text.count > 1
            let plainWord = !text.contains(where: \.isNumber) && text.count <= 32 && isCode(text)
            return isVersion || plainWord ? text : ":id"
        }
        return "/" + segments.joined(separator: "/")
    }

    /// A text of the system (an exception, a termination reason) as one code.
    public static func slug(_ text: String) -> String {
        let cleaned = text.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) && $0.isASCII ? String($0) : "_" }.joined()
        return String(cleaned.drop { $0 == "_" }.prefix(80))
    }

    /// A coding path of a failed decode: its keys only, never the value that failed.
    public static func codingPath(_ path: [CodingKey]) -> String {
        let keys = path.map { key -> String in
            if key.intValue != nil { return "n" }
            return key.stringValue.contains(where: \.isNumber) ? "id" : key.stringValue
        }
        return slugPath(keys.joined(separator: "."))
    }

    private static func slugPath(_ path: String) -> String {
        path.isEmpty ? "root" : String(path.prefix(80))
    }
}

/// The phone's own record of what happened, kept only on this phone until the person shares a report: the last 7 days,
/// at most two files of 1 MB. Off until the app calls `enable()`, so widgets, the watch and tests write nothing. Writes
/// happen on one queue and can never fail or slow down the caller.
public final class DiagnosticLog: @unchecked Sendable {
    public static let shared = DiagnosticLog(directory: DiagnosticLog.defaultDirectory)
    public static let retention: TimeInterval = 7 * 24 * 3_600
    public static let maxFileBytes = 1_000_000

    private let directory: URL
    private let now: () -> Date
    private let maxBytes: Int
    private let queue = DispatchQueue(label: "pl.mellis.diagnostic-log", qos: .utility)
    private var enabled = false

    private var current: URL { directory.appendingPathComponent("events.jsonl") }
    private var older: URL { directory.appendingPathComponent("events.old.jsonl") }

    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Diagnostics", isDirectory: true)
    }

    public init(directory: URL, now: @escaping () -> Date = Date.init, maxBytes: Int = DiagnosticLog.maxFileBytes) {
        self.directory = directory
        self.now = now
        self.maxBytes = maxBytes
    }

    public func enable() {
        queue.async { self.enabled = true }
    }

    public func record(_ category: DiagnosticCategory, _ event: String, _ fields: [String: String] = [:]) {
        let at = now()
        queue.async {
            guard self.enabled, DiagnosticSanitizer.isCode(event) else { return }
            self.append(DiagnosticEntry(at: at, category: category, event: event, fields: DiagnosticSanitizer.fields(fields)))
        }
    }

    /// The newest `limit` entries of the retention period, oldest first.
    public func entries(limit: Int = 500) -> [DiagnosticEntry] {
        queue.sync {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let cutoff = now().addingTimeInterval(-Self.retention)
            let lines = [older, current].flatMap { url -> [Substring] in
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
                return text.split(separator: "\n")
            }
            let entries = lines.compactMap { try? decoder.decode(DiagnosticEntry.self, from: Data($0.utf8)) }
            return Array(entries.filter { $0.at >= cutoff }.suffix(limit))
        }
    }

    private func append(_ entry: DiagnosticEntry) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let line = try? encoder.encode(entry) else { return }
        do {
            try prepareDirectory()
            rotateIfNeeded(adding: line.count + 1)
            if !FileManager.default.fileExists(atPath: current.path) {
                FileManager.default.createFile(atPath: current.path, contents: nil, attributes: Self.fileAttributes)
            }
            let handle = try FileHandle(forWritingTo: current)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line + Data("\n".utf8))
        } catch {
            // Before the first unlock the file cannot be opened: this event is lost, the app goes on.
        }
    }

    private func prepareDirectory() throws {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    private func rotateIfNeeded(adding bytes: Int) {
        let size = (try? FileManager.default.attributesOfItem(atPath: current.path)[.size] as? Int) ?? 0
        guard size + bytes > maxBytes else { return }
        try? FileManager.default.removeItem(at: older)
        try? FileManager.default.moveItem(at: current, to: older)
    }

    private static var fileAttributes: [FileAttributeKey: Any]? {
        #if os(iOS)
        // Pushes and background work write while the phone is locked.
        return [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        return nil
        #endif
    }
}
