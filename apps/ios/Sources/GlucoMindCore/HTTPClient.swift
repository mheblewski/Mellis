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
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code != .cancelled {
            guard Self.neverReachedServer(error.code) || Self.isRead(request) else { throw error }
            throw APIClientError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        return (data, http)
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
