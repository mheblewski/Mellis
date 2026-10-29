import XCTest
@testable import GlucoMindCore

final class SuggestedFollowUpsDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> ConversationMessage {
        try JSONDecoder().decode(ConversationMessage.self, from: Data(json.utf8))
    }

    func testDecodesSuggestedFollowUpsOnAnAssistantMessage() throws {
        let message = try decode("""
        {"id":"m1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Hej!","created_at":"2026-10-15T10:00:00Z",
         "suggested_follow_ups":["Co mogło spowodować spadek o 10:28?","Pokaż insulinę przed spadkiem"]}
        """)
        XCTAssertEqual(message.suggested_follow_ups, ["Co mogło spowodować spadek o 10:28?", "Pokaż insulinę przed spadkiem"])
    }

    func testDecodesTheHotSuggestion() throws {
        let message = try decode("""
        {"id":"m3","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Hej!","created_at":"2026-10-16T10:00:00Z",
         "suggested_follow_ups":["Czy będzie skok koło 14:00?","Kiedy wpisać WBT po pizzy?"],
         "hot_suggested_follow_up":"Kiedy wpisać WBT po pizzy?"}
        """)
        XCTAssertEqual(message.hot_suggested_follow_up, "Kiedy wpisać WBT po pizzy?")
    }

    func testOlderMessagesWithoutSuggestionsStillDecode() throws {
        let message = try decode("""
        {"id":"m2","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Hej!","created_at":"2026-10-15T10:00:00Z"}
        """)
        XCTAssertNil(message.suggested_follow_ups)
        XCTAssertNil(message.hot_suggested_follow_up)
    }
}

final class KnowledgeSourcesDecodingTests: XCTestCase {
    func testDecodesCitedSourcesAndBuildsACompactDetail() throws {
        let message = try JSONDecoder().decode(ConversationMessage.self, from: Data("""
        {"id":"m1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Korekta +10% [S1].","created_at":"2026-10-16T10:00:00Z",
         "knowledge_sources":[{"ref":"S1","title":"ISPAD 2022: Sick day management","section":"8 Ketones > 8.3 Insulin > 8.3.2 Extra insulin","page":5,"page_end":6},
                              {"ref":"S2","title":"Dexcom G7 User Guide","section":null,"page":null,"page_end":null}]}
        """.utf8))
        XCTAssertEqual(message.knowledge_sources?.map(\.ref), ["S1", "S2"])
        XCTAssertEqual(message.knowledge_sources?.first?.displayDetail, "ISPAD 2022: Sick day management · 8.3.2 Extra insulin · s. 5–6")
        XCTAssertEqual(message.knowledge_sources?.last?.displayDetail, "Dexcom G7 User Guide")
        let caption = KnowledgeSource(ref: "S3", title: "ISPAD", section: String(repeating: "Table 3 caption ", count: 10), page: 2)
        XCTAssertEqual(caption.displayDetail, "ISPAD · " + String(String(repeating: "Table 3 caption ", count: 10).prefix(79)).trimmingCharacters(in: .whitespaces) + "… · s. 2")
    }

    func testSourceLinkToTheOriginalOnlyForHttp() throws {
        let message = try JSONDecoder().decode(ConversationMessage.self, from: Data("""
        {"id":"m3","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"[S1] [S2]","created_at":"2026-10-16T10:00:00Z",
         "knowledge_sources":[{"ref":"S1","title":"ISPAD 2022: Sick day management","section":null,"page":null,"page_end":null,"url":"https://doi.org/10.1111/pedi.13415"},
                              {"ref":"S2","title":"Bad","section":null,"page":null,"page_end":null,"url":"javascript:alert(1)"}]}
        """.utf8))
        XCTAssertEqual(message.knowledge_sources?.first?.originalURL?.absoluteString, "https://doi.org/10.1111/pedi.13415")
        XCTAssertNil(message.knowledge_sources?.last?.originalURL)
        XCTAssertNil(KnowledgeSource(ref: "S3", title: "No link").originalURL)
    }

    func testMessagesWithoutSourcesStillDecode() throws {
        let message = try JSONDecoder().decode(ConversationMessage.self, from: Data("""
        {"id":"m2","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Hej!","created_at":"2026-10-16T10:00:00Z"}
        """.utf8))
        XCTAssertNil(message.knowledge_sources)
    }
}
