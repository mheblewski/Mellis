import CoreImage
import XCTest
@testable import GlucoMindCore

/// Loop's QR code read from a picture (a screenshot from Photos or Files), with a real QR code drawn by CoreImage.
final class LoopQRImageReaderTests: XCTestCase {
    private let loopURL = "otpauth://totp/Loop?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA1&digits=6&period=30"

    /// A PNG with the QR code of `text`, scaled up and on a white margin, as a screenshot would have it.
    private func png(qr text: String) throws -> Data {
        let filter = try XCTUnwrap(CIFilter(name: "CIQRCodeGenerator", parameters: ["inputMessage": Data(text.utf8), "inputCorrectionLevel": "M"]))
        let code = try XCTUnwrap(filter.outputImage).transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let canvas = CIImage(color: .white).cropped(to: code.extent.insetBy(dx: -60, dy: -60))
        let picture = code.composited(over: canvas)
        return try XCTUnwrap(CIContext().pngRepresentation(of: picture, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()))
    }

    func testReadsLoopsCodeFromAPicture() throws {
        XCTAssertEqual(LoopQRImageReader.read(imageData: try png(qr: loopURL)), .success(loopURL))
    }

    func testSaysWhyAPictureGivesNoCode() throws {
        XCTAssertEqual(LoopQRImageReader.read(imageData: try png(qr: "https://example.com")), .failure(.notLoopsCode))
        let blank = try XCTUnwrap(CIContext().pngRepresentation(of: CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 200)), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()))
        XCTAssertEqual(LoopQRImageReader.read(imageData: blank), .failure(.noQRCode))
        XCTAssertEqual(LoopQRImageReader.read(imageData: Data("not an image".utf8)), .failure(.notAnImage))
    }
}
