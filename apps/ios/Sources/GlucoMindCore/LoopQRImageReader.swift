import CoreImage
import Foundation

/// Loop's QR code read from a picture (a screenshot of Loop's remote commands screen from the photo library or Files):
/// the first QR code in it that is a Loop one-time password URL (LoopOTP).
public enum LoopQRImageReader {
    public enum ReadError: Error, Equatable {
        /// Not a picture CoreImage can open.
        case notAnImage
        /// A picture without any QR code.
        case noQRCode
        /// QR codes, but none of them Loop's (otpauth://totp with a secret).
        case notLoopsCode

        public var message: String {
            switch self {
            case .notAnImage: return "Nie udało się otworzyć obrazu."
            case .noQRCode: return "Na obrazie nie ma kodu QR. Zrób zrzut ekranu z kodem QR z Loopa i spróbuj ponownie."
            case .notLoopsCode: return "Ten kod QR nie jest kodem zdalnych poleceń Loopa."
            }
        }
    }

    public static func read(imageData: Data) -> Result<String, ReadError> {
        guard let image = CIImage(data: imageData) else { return .failure(.notAnImage) }
        let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        let codes = (detector?.features(in: image) ?? []).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        guard !codes.isEmpty else { return .failure(.noQRCode) }
        guard let loopCode = codes.first(where: { LoopOTP(url: $0) != nil }) else { return .failure(.notLoopsCode) }
        return .success(loopCode)
    }

    /// The same from a file the caregiver picked (security-scoped URL from the Files picker).
    public static func read(fileURL: URL) -> Result<String, ReadError> {
        let scoped = fileURL.startAccessingSecurityScopedResource()
        defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: fileURL) else { return .failure(.notAnImage) }
        return read(imageData: data)
    }
}
