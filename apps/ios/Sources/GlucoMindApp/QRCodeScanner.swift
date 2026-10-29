import SwiftUI
#if os(iOS) && canImport(VisionKit)
import VisionKit

/// The camera reading QR codes: Loop's code of remote commands (otpauth://totp/…) and Mellis pairing links
/// (mellis://pair?…). The first code `accepts` takes closes it; other codes are ignored.
struct QRCodeScanner: UIViewControllerRepresentable {
    let accepts: (String) -> Bool
    let onCode: (String) -> Void

    static var isSupported: Bool { DataScannerViewController.isSupported }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(accepts: accepts, onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let accepts: (String) -> Bool
        let onCode: (String) -> Void
        private var done = false

        init(accepts: @escaping (String) -> Bool, onCode: @escaping (String) -> Void) {
            self.accepts = accepts
            self.onCode = onCode
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                guard !done, case let .barcode(code) = item, let text = code.payloadStringValue, accepts(text) else { continue }
                done = true
                scanner.stopScanning()
                onCode(text)
            }
        }
    }
}
#endif
