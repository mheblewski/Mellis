import XCTest
@testable import GlucoMindCore

/// A POST reply (send, answer, cancel, retry) without what only GET returns keeps the screen's cards and hypo data.
final class ConversationReplyMergeTests: XCTestCase {
    private func conversation(_ messages: [String], id: String = "c1", extra: String = "") throws -> ConversationResponse {
        try JSONDecoder().decode(ConversationResponse.self, from: Data("""
        {"id":"\(id)","patient_id":"p1","awaiting_user_answer":false,"pending_question":null,"analysis_id":null,
         "recommendation_id":null,"messages":[\(messages.joined(separator: ","))]\(extra)}
        """.utf8))
    }

    private let question = #"{"id":"u1","role":"USER","message_type":"USER_MESSAGE","content":"Ile podać?","created_at":"2026-10-22T10:00:00Z"}"#
    private let answer = #"{"id":"a1","role":"ASSISTANT","message_type":"DIRECT_RESPONSE","content":"2 j","created_at":"2026-10-22T10:00:10Z","care_reminders":[]}"#
    private let bareAnswer = #"{"id":"a1","role":"ASSISTANT","message_type":"DIRECT_RESPONSE","content":"2 j","created_at":"2026-10-22T10:00:10Z"}"#
    private let followUp = #"{"id":"u2","role":"USER","message_type":"USER_MESSAGE","content":"A teraz?","created_at":"2026-10-22T10:05:00Z"}"#

    func testAReplyWithoutGetOnlyFieldsKeepsTheCurrentOnes() throws {
        let current = try conversation([question, answer], extra: #","reply_draft":{"reply_to_message_id":"u1","content":"Pisz"}"#)

        let sent = try conversation([question, bareAnswer, followUp]).keepingViewFields(of: current)
        XCTAssertEqual(sent.messages.map(\.id), ["u1", "a1", "u2"], "the reply's messages win")
        XCTAssertEqual(sent.messages[1].care_reminders, [], "the answer's cards stay")
        XCTAssertNil(sent.reply_draft, "a draft for an earlier message is not kept")

        let cancelled = try conversation([question]).keepingViewFields(of: current)
        XCTAssertEqual(cancelled.reply_draft?.content, "Pisz", "the draft of the latest message stays")
    }

    func testAnotherConversationIsNotMerged() throws {
        let current = try conversation([answer])
        let other = try conversation([], id: "c2")
        XCTAssertEqual(other.keepingViewFields(of: current), other)
    }

    func testTheMealsOfTheBolusCardsAreKnown() throws {
        let card = #"""
        {"id":"a2","role":"ASSISTANT","message_type":"DIRECT_RESPONSE","content":"Bolus","created_at":"2026-10-22T10:00:10Z",
         "bolus_proposals":[{"id":"bp","purpose":"MEAL","carbs_g":30,"insulin_u":3,"icr_g_per_u":10,"icr_insulin_u":3,"meal_description":null,
           "meal":null,"reason":null,"warnings":[],"expires_at":"2026-10-22T10:15:00Z","state":"PROPOSED","command":null,
           "wbt_reminder":{"meal_id":"meal-1","remind_at":"2026-10-22T12:30:00Z","status":"SCHEDULED","enabled":true}}]}
        """#
        XCTAssertEqual(try conversation([question, card]).bolusCardMealIDs, ["meal-1"])
    }
}
