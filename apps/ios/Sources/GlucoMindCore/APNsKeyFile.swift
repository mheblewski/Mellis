import Foundation

/// An APNs key file (.p8) from developer.apple.com, for the remote control settings of Trio and Loop.
public enum APNsKeyFile {
    public struct Key: Equatable {
        public let pem: String
        /// From Apple's file name AuthKey_<KEY ID>.p8 (also "AuthKey_ABC123DEFG 2.p8"); nil when the name does not say.
        public let keyID: String?
    }

    /// The key in a file the caregiver picked, or why it cannot be used (Polish).
    public static func read(_ url: URL) -> Result<Key, ReadError> {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), let pem = String(data: data, encoding: .utf8) else {
            return .failure(ReadError(message: "Nie udało się odczytać pliku. Jeśli jest w iCloud, otwórz go raz w aplikacji Pliki, żeby się pobrał."))
        }
        return parse(pem: pem, fileName: url.lastPathComponent)
    }

    public static func parse(pem: String, fileName: String) -> Result<Key, ReadError> {
        guard pem.contains("BEGIN PRIVATE KEY") else {
            return .failure(ReadError(message: "To nie jest klucz APNs: plik .p8 z developer.apple.com zaczyna się od „BEGIN PRIVATE KEY”."))
        }
        let name = (fileName as NSString).deletingPathExtension
        let keyID = name.hasPrefix("AuthKey_") ? String(name.dropFirst("AuthKey_".count).prefix(10)) : nil
        return .success(Key(pem: pem, keyID: keyID.flatMap { APNsAuthToken.isKeyID($0) ? $0 : nil }))
    }

    /// A key pasted by hand (the file's text, or only its base64 body) with its Key ID typed next to it (owner 2026-11-03:
    /// a friend had the key's text and its id, not the file). Returns the key as a clean PEM, or why it cannot be used.
    public static func parsePasted(_ text: String, keyID rawKeyID: String) -> Result<Key, ReadError> {
        let keyID = rawKeyID.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let body = text
            .replacingOccurrences(of: "\u{FEFF}", with: "")
            .components(separatedBy: .newlines)
            // The header lines, however their dashes came out (typing turns "--" into "—").
            .filter { !$0.uppercased().contains("PRIVATE KEY") && !$0.contains("-----") }
            .joined()
            .filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=") }
        guard !body.isEmpty else { return .failure(ReadError(message: "Wklej cały klucz: tekst między „BEGIN PRIVATE KEY” a „END PRIVATE KEY”.")) }
        var lines: [String] = []
        var rest = Substring(body)
        while !rest.isEmpty { lines.append(String(rest.prefix(64))); rest = rest.dropFirst(64) }
        let pem = (["-----BEGIN PRIVATE KEY-----"] + lines + ["-----END PRIVATE KEY-----"]).joined(separator: "\n")
        guard (try? APNsAuthToken.parseKey(pem)) != nil else {
            return .failure(ReadError(message: "To nie wygląda na klucz APNs. Wklej całą treść pliku .p8, bez zmian."))
        }
        guard APNsAuthToken.isKeyID(keyID) else {
            return .failure(ReadError(message: "Key ID ma 10 znaków (litery i cyfry), np. ABC123DEFG. Znajdziesz go na developer.apple.com → Keys, przy tym kluczu."))
        }
        return .success(Key(pem: pem, keyID: keyID))
    }

    public struct ReadError: Error, Equatable {
        public let message: String
    }
}
