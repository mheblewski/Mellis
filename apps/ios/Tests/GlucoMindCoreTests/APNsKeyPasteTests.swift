import XCTest
@testable import GlucoMindCore

/// "Wklej klucz i Key ID" (owner 2026-11-03): a key pasted as text, checked before it is saved.
final class APNsKeyPasteTests: XCTestCase {
    /// A throwaway P-256 key generated for these tests (not an Apple key).
    private let body = [
        "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5kpsG6l2lB3pXegW",
        "TOEyzMynfZFbKhNZTvtLTc6ncRqhRANCAATSjMU+b9Vk63O+VHbF24kH2SHnToGl",
        "e+wzF+Enyzzw2H9lpubtBRWyT0oYcYym3TOR4XxAKiz2ZGjOnS2Sv+gi",
    ]

    func testTheWholeFileOrOnlyItsBodyWithSpacesBecomesOneCleanPEM() throws {
        let whole = "  -----BEGIN PRIVATE KEY-----\r\n" + body.joined(separator: "\r\n") + "\r\n-----END PRIVATE KEY-----  \n"
        let onlyBody = body.joined(separator: " ")
        // Typed by hand on a phone: "-----" becomes "——" (smart punctuation).
        let typed = "——-BEGIN PRIVATE KEY——-\n" + body.joined(separator: "\n") + "\n——-END PRIVATE KEY——-"
        for text in [whole, onlyBody, typed] {
            let key = try APNsKeyFile.parsePasted(text, keyID: " abc123defg ").get()
            XCTAssertEqual(key.keyID, "ABC123DEFG")
            XCTAssertTrue(key.pem.hasPrefix("-----BEGIN PRIVATE KEY-----\n"))
            XCTAssertTrue(key.pem.hasSuffix("\n-----END PRIVATE KEY-----"))
            XCTAssertNoThrow(try APNsAuthToken(keyID: "ABC123DEFG", teamID: "TEAM123456", p8: key.pem))
        }
    }

    func testRefusesTextThatIsNotAKeyAndAKeyIDThatIsNotTenCharacters() {
        XCTAssertEqual(try? APNsKeyFile.parsePasted("hello world", keyID: "ABC123DEFG").get(), nil)
        if case let .failure(error) = APNsKeyFile.parsePasted(body.joined(), keyID: "Trio push") {
            XCTAssertTrue(error.message.hasPrefix("Key ID ma 10 znaków"))
        } else {
            XCTFail("a key name is not a Key ID")
        }
        if case let .failure(error) = APNsKeyFile.parsePasted("   ", keyID: "ABC123DEFG") {
            XCTAssertTrue(error.message.hasPrefix("Wklej cały klucz"))
        } else {
            XCTFail("empty text")
        }
    }
}
