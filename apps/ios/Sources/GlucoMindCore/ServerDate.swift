import Foundation

/// The server's ISO 8601 timestamps, with or without fractional seconds ("2026-10-21T08:00:00.123Z" and
/// "2026-10-21T08:00:00Z" both occur: Postgres drops ".000"). One parser for every screen.
public enum ServerDate {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let whole = ISO8601DateFormatter()

    public static func parse(_ value: String) -> Date? {
        fractional.date(from: value) ?? whole.date(from: value)
    }

    /// A moment for the server (query strings), in UTC.
    public static func string(_ date: Date) -> String {
        whole.string(from: date)
    }
}
