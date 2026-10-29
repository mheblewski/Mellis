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

    public struct ReadError: Error, Equatable {
        public let message: String
    }
}
