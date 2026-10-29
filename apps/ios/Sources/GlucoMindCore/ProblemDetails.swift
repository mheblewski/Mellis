import Foundation

public struct ProblemDetails: Codable, Error, Equatable {
    public let type: String
    public let title: String
    public let status: Int
    public let code: String
    public let instance: String?
}

public enum APIClientError: Error, Equatable {
    case unauthenticated(ProblemDetails?)
    case forbidden(ProblemDetails?)
    case notFound(ProblemDetails?)
    case conflict(ProblemDetails?)
    case validation(ProblemDetails?)
    case server(ProblemDetails?)
    case transport(String)
    case unexpectedStatus(Int, ProblemDetails?)
    case invalidResponse
}

public extension APIClientError {
    /// The server's problem code (`code` of problem+json), when the answer had one.
    var problemCode: String? {
        switch self {
        case let .unauthenticated(details), let .forbidden(details), let .notFound(details), let .conflict(details),
             let .validation(details), let .server(details), let .unexpectedStatus(_, details):
            return details?.code
        case .transport, .invalidResponse:
            return nil
        }
    }

    /// The save was based on data the other caregiver changed in the meantime (409 STALE_WRITE): nothing was written.
    var isStaleWrite: Bool {
        if case let .conflict(problem) = self {
            return problem?.code == "STALE_WRITE"
        }
        return false
    }
}

public extension Error {
    var isStaleWrite: Bool {
        (self as? APIClientError)?.isStaleWrite ?? false
    }
}
