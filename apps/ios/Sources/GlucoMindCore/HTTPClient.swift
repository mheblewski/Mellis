import Foundation

public protocol HTTPClient {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionHTTPClient: HTTPClient {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// A connection failure throws `APIClientError.transport`, so the screens say "Brak połączenia" (for a write: "nic
    /// nie zapisano"). A write that timed out or lost the connection may have reached the server, so it keeps its
    /// `URLError` and reads as a plain failure. A cancelled request keeps `URLError.cancelled` (or `CancellationError`):
    /// callers ignore it.
    public func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        let startedAt = Date()
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code != .cancelled {
            Self.recordFailure(request, startedAt: startedAt, fields: ["url_error": "\(error.code.rawValue)"])
            guard Self.neverReachedServer(error.code) || Self.isRead(request) else { throw error }
            throw APIClientError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        if !(200...299).contains(http.statusCode) {
            Self.recordFailure(request, startedAt: startedAt, fields: ["status": "\(http.statusCode)"])
        } else if Date().timeIntervalSince(startedAt) >= Self.slowRequestSeconds {
            DiagnosticLog.shared.record(.network, "request_slow", Self.diagnosticFields(request, startedAt: startedAt))
        }
        return (data, http)
    }

    /// Successful requests are not logged (the app polls): only failures and the ones slow enough to be felt.
    private static let slowRequestSeconds: TimeInterval = 3

    private static func recordFailure(_ request: URLRequest, startedAt: Date, fields: [String: String]) {
        DiagnosticLog.shared.record(.network, "request_failed", diagnosticFields(request, startedAt: startedAt).merging(fields) { _, new in new })
    }

    private static func diagnosticFields(_ request: URLRequest, startedAt: Date) -> [String: String] {
        [
            "method": request.httpMethod ?? "GET",
            "route": DiagnosticSanitizer.routeTemplate(request.url),
            "ms": "\(Int(Date().timeIntervalSince(startedAt) * 1000))",
        ]
    }

    private static func neverReachedServer(_ code: URLError.Code) -> Bool {
        [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .internationalRoamingOff,
         .dataNotAllowed].contains(code)
    }

    private static func isRead(_ request: URLRequest) -> Bool {
        let method = (request.httpMethod ?? "GET").uppercased()
        return method == "GET" || method == "HEAD"
    }
}

public extension Error {
    /// A cancelled request is not a failed one: Swift's CancellationError or URLSession's -999.
    var isRequestCancellation: Bool {
        if self is CancellationError { return true }
        if let urlError = self as? URLError, urlError.code == .cancelled { return true }
        return (self as NSError).domain == NSURLErrorDomain && (self as NSError).code == NSURLErrorCancelled
    }
}
