import XCTest
@testable import GlucoMindCore

final class MessageAuthorDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> ConversationMessage {
        try JSONDecoder().decode(ConversationMessage.self, from: Data(json.utf8))
    }

    func testDecodesTheAuthorOfACaregiverMessage() throws {
        let message = try decode("""
        {"id":"m1","role":"USER","message_type":"USER_MESSAGE","content":"Jak minęła noc?","created_at":"2026-10-15T10:00:00Z",
         "author_user_id":"7c1e4b2a-9d3f-4a6e-8b05-2f9d6c3e1a47","author_display_name":"Piotr"}
        """)
        XCTAssertEqual(message.author_display_name, "Piotr")
    }

    func testMessagesWithoutAnAuthorStillDecode() throws {
        let message = try decode("""
        {"id":"m2","role":"USER","message_type":"USER_MESSAGE","content":"Hej","created_at":"2026-10-15T10:00:00Z",
         "author_display_name":null}
        """)
        XCTAssertNil(message.author_display_name)
    }
}
