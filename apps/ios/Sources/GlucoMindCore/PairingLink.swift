import Foundation

/// `mellis://pair?server=<https://…>&code=<code>`: the QR code / link of the setup, another phone of the same person, an
/// invitation and `mellis reset-owner`. Read from a deep link, a camera scan or text the person pasted (a share message
/// with the link inside counts too).
public struct PairingLink: Equatable, Sendable {
    public let serverURL: URL
    public let code: String

    public init(serverURL: URL, code: String) {
        self.serverURL = serverURL
        self.code = code
    }

    public static let scheme = "mellis"

    public enum ParseError: Error, Equatable {
        case notALink
        case missingServer
        case insecureServer
        case missingCode

        public var message: String {
            switch self {
            case .notALink: return "To nie jest kod Mellisa. Zeskanuj kod QR albo wklej link zaczynający się od mellis://pair."
            case .missingServer: return "W linku brakuje adresu serwera."
            case .insecureServer: return "Adres serwera musi zaczynać się od https://."
            case .missingCode: return "W linku brakuje kodu albo kod jest za krótki."
            }
        }
    }

    /// `allowsInsecureHTTP`: Debug builds accept an http:// server (a local development server); others need https.
    public static func parse(_ text: String, allowsInsecureHTTP: Bool) -> Result<PairingLink, ParseError> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(of: "\(scheme)://", options: .caseInsensitive) else { return .failure(.notALink) }
        // The link ends at the first whitespace (a message may carry words after it).
        let tail = trimmed[range.lowerBound...]
        let raw = String(tail.prefix(while: { !$0.isWhitespace }))
        guard let url = URL(string: raw) else { return .failure(.notALink) }
        return parse(url, allowsInsecureHTTP: allowsInsecureHTTP)
    }

    public static func parse(_ url: URL, allowsInsecureHTTP: Bool) -> Result<PairingLink, ParseError> {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == "pair" else { return .failure(.notALink) }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value: (String) -> String? = { name in
            items.first(where: { $0.name.lowercased() == name })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let serverText = value("server"), !serverText.isEmpty else { return .failure(.missingServer) }
        let server: URL
        switch serverURL(serverText, allowsInsecureHTTP: allowsInsecureHTTP) {
        case let .success(parsed): server = parsed
        case let .failure(error): return .failure(error)
        }
        guard let code = value("code"), OneTimeCode.isPlausible(code) else { return .failure(.missingCode) }
        return .success(PairingLink(serverURL: server, code: code))
    }

    /// A server address as typed or carried in a link: http(s) with a host, no query, no trailing slash.
    public static func serverURL(_ text: String, allowsInsecureHTTP: Bool) -> Result<URL, ParseError> {
        var candidate = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !candidate.contains("://") { candidate = "https://" + candidate }
        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty else {
            return .failure(.missingServer)
        }
        guard scheme == "https" || (scheme == "http" && allowsInsecureHTTP) else {
            return .failure(scheme == "http" ? .insecureServer : .missingServer)
        }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { return .failure(.missingServer) }
        return .success(url)
    }

    /// The same server: scheme, host and port (a link of another server is an invitation this phone cannot accept).
    public func isSameServer(as other: URL) -> Bool {
        Self.origin(serverURL) == Self.origin(other)
    }

    static func origin(_ url: URL) -> String {
        let scheme = url.scheme?.lowercased() ?? ""
        let host = url.host?.lowercased() ?? ""
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)\(url.path)"
    }
}
