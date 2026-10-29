import XCTest
@testable import GlucoMindCore

final class ConversationHistoryTests: XCTestCase {
    func testGroupsHistoryIntoTodayYesterdayAndOlder() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let calendar = Calendar(identifier: .gregorian)

        let today = isoDate(now.addingTimeInterval(-60 * 15))
        let yesterday = isoDate(now.addingTimeInterval(-60 * 60 * 24))
        let older = isoDate(now.addingTimeInterval(-60 * 60 * 24 * 8))

        let items = [
            historyItem(conversationID: "conv-today", createdAt: today, updatedAt: today),
            historyItem(conversationID: "conv-yesterday", createdAt: yesterday, updatedAt: yesterday),
            historyItem(conversationID: "conv-older", createdAt: older, updatedAt: older)
        ]

        let sections = ConversationHistoryGrouper.sections(from: items, now: now, calendar: calendar)

        XCTAssertEqual(sections.count, 3)
        XCTAssertEqual(sections.first?.title, "Dziś")
        XCTAssertEqual(sections.first?.entries.first?.conversationID, "conv-today")
        XCTAssertEqual(sections[1].title, "Wczoraj")
    }

    func testRowsSortedByMostRecentlyUpdated() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let started = isoDate(now)

        let oldUpdate = isoDate(now.addingTimeInterval(-120))
        let newUpdate = isoDate(now)

        let items = [
            historyItem(conversationID: "conv-old", createdAt: started, updatedAt: oldUpdate),
            historyItem(conversationID: "conv-new", createdAt: started, updatedAt: newUpdate)
        ]

        let sections = ConversationHistoryGrouper.sections(from: items, now: now)

        XCTAssertEqual(sections.first?.entries.first?.conversationID, "conv-new")
        XCTAssertEqual(sections.first?.entries.last?.conversationID, "conv-old")
    }

    func testDeterministicTitleForHypoConversations() {
        let value = ConversationHistoryTitleBuilder.title(triggerType: .hypo)
        XCTAssertEqual(value, "Niska glikemia")
    }

    func testGenericTitleDoesNotAssumeHypo() {
        let value = ConversationHistoryTitleBuilder.title(triggerType: .none)
        XCTAssertEqual(value, "Rozmowa")
    }

    func testConversationHistoryItemCanRepresentUserOriginWithoutTrigger() {
        let now = Date()
        let item = ConversationHistoryItem(
            conversationID: "user-conv-1",
            title: "Rozmowa",
            status: "OPEN",
            awaitingUserAnswer: true,
            origin: .user,
            triggerType: .none,
            createdAt: now,
            updatedAt: now
        )

        XCTAssertEqual(item.origin, .user)
        XCTAssertEqual(item.triggerType, .none)
        XCTAssertEqual(item.conversationID, "user-conv-1")
    }

    func testTitleUsesTheFirstQuestionForUserConversationsOnly() {
        XCTAssertEqual(ConversationListHistoryAdapter.title(preview: "  Jak minął dzień? ", triggerType: .none), "Jak minął dzień?")
        XCTAssertEqual(ConversationListHistoryAdapter.title(preview: nil, triggerType: .none), "Rozmowa")
        XCTAssertEqual(ConversationListHistoryAdapter.title(preview: "", triggerType: .none), "Rozmowa")
        XCTAssertEqual(ConversationListHistoryAdapter.title(preview: "x", triggerType: .hypo), "Niska glikemia")
    }

    func testConversationNameWinsOverTheFirstQuestionAndTheTriggerName() {
        XCTAssertEqual(ConversationListHistoryAdapter.title(name: " Pizza w sobotę ", preview: "Jak minął dzień?", triggerType: .none), "Pizza w sobotę")
        XCTAssertEqual(ConversationListHistoryAdapter.title(name: "Nocny spadek", preview: nil, triggerType: .hypo), "Nocny spadek")
        XCTAssertEqual(ConversationListHistoryAdapter.title(name: "  ", preview: "Jak minął dzień?", triggerType: .none), "Jak minął dzień?")
    }

    func testPinnedConversationsGetTheirOwnSectionOnTopMostRecentlyPinnedFirst() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let calendar = Calendar(identifier: .gregorian)
        let json = """
        {"patient_id":"p","next_cursor":null,"items":[
          \(listItemJSON(id: "pinned-old", createdAt: isoDate(now.addingTimeInterval(-86_400 * 9)), title: "Pizza w sobotę", pinnedAt: isoDate(now.addingTimeInterval(-3_600)))),
          \(listItemJSON(id: "pinned-new", createdAt: isoDate(now.addingTimeInterval(-86_400 * 20)), title: nil, pinnedAt: isoDate(now.addingTimeInterval(-60)))),
          \(listItemJSON(id: "today", createdAt: isoDate(now.addingTimeInterval(-600)), title: nil, pinnedAt: nil))
        ]}
        """
        let response = try JSONDecoder().decode(ConversationsListResponse.self, from: Data(json.utf8))
        let items = ConversationListHistoryAdapter.makeItems(from: response.items)
        let sections = ConversationHistoryGrouper.sections(from: items, now: now, calendar: calendar)

        XCTAssertEqual(sections.map(\.title), ["Przypięte", "Dziś"])
        XCTAssertEqual(sections[0].entries.map(\.conversationID), ["pinned-new", "pinned-old"])
        XCTAssertTrue(sections[0].entries.allSatisfy(\.isPinned))
        XCTAssertEqual(sections[0].entries[1].title, "Pizza w sobotę")
        XCTAssertFalse(sections[1].entries[0].isPinned)
    }

    func testTimestampsWithoutFractionalSecondsKeepTheConversation() throws {
        let json = """
        {"patient_id":"p","next_cursor":null,"items":[
          \(listItemJSON(id: "whole-seconds", createdAt: "2026-10-21T08:00:00Z", title: nil, pinnedAt: nil)),
          \(listItemJSON(id: "fractional", createdAt: "2026-10-21T08:05:00.123Z", title: nil, pinnedAt: nil))
        ]}
        """
        let response = try JSONDecoder().decode(ConversationsListResponse.self, from: Data(json.utf8))
        let items = ConversationListHistoryAdapter.makeItems(from: response.items)

        XCTAssertEqual(items.map(\.conversationID), ["whole-seconds", "fractional"])
        XCTAssertEqual(ServerDate.parse("2026-10-21T08:00:00Z"), ServerDate.parse("2026-10-21T08:00:00.000Z"))
        XCTAssertNil(ServerDate.parse("21.10.2026"))
    }

    func testListItemsFromOlderServersHaveNoNameAndNoPin() throws {
        let json = """
        {"patient_id":"p","next_cursor":null,"items":[\(listItemJSON(id: "c", createdAt: isoDate(Date()), title: nil, pinnedAt: nil, includeNewFields: false))]}
        """
        let response = try JSONDecoder().decode(ConversationsListResponse.self, from: Data(json.utf8))
        XCTAssertNil(response.items[0].title)
        XCTAssertNil(response.items[0].pinned_at)
    }

    func testRenameDraftIsOneLineOfAtMost80Characters() {
        XCTAssertEqual(ConversationTitleDraft.normalized("  Pizza \n  w   sobotę "), "Pizza w sobotę")
        XCTAssertNil(ConversationTitleDraft.normalized(" \n "))
        XCTAssertEqual(ConversationTitleDraft.normalized(String(repeating: "a", count: 100))?.count, 80)
    }

    private func historyItem(conversationID: String, createdAt: String, updatedAt: String) -> ConversationHistoryItem {
        let formatter = ISO8601DateFormatter.fullWithFractionalSeconds
        let createdDate = formatter.date(from: createdAt) ?? Date()
        let updatedDate = formatter.date(from: updatedAt) ?? Date()

        return ConversationHistoryItem(
            conversationID: conversationID,
            title: "Rozmowa",
            status: "QUESTION_PENDING",
            awaitingUserAnswer: true,
            origin: .system,
            triggerType: .hypo,
            createdAt: createdDate,
            updatedAt: updatedDate
        )
    }

    private func listItemJSON(id: String, createdAt: String, title: String?, pinnedAt: String?, includeNewFields: Bool = true) -> String {
        let newFields = includeNewFields
            ? #","title":\#(title.map { "\"\($0)\"" } ?? "null"),"pinned_at":\#(pinnedAt.map { "\"\($0)\"" } ?? "null")"#
            : ""
        return #"{"id":"\#(id)","patient_id":"p","episode_id":null,"trigger_id":null,"origin":"USER","trigger_type":null,"thread_state_version":"conv-v1","awaiting_user_answer":false,"conversation_type":"USER_INITIATED","workflow_status":"ACTIVE","analysis_id":null,"recommendation_id":null,"created_at":"\#(createdAt)","updated_at":"\#(createdAt)","activity_status":"COMPLETED","activity_checked_at":null,"title_preview":"Pytanie"\#(newFields)}"#
    }

    private func isoDate(_ date: Date) -> String {
        ISO8601DateFormatter.fullWithFractionalSeconds.string(from: date)
    }
}

private extension ISO8601DateFormatter {
    static let fullWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
