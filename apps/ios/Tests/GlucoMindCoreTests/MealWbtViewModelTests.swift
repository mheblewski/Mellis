import XCTest
@testable import GlucoMindCore

private final class FakeWbtAPI: MealWbtAPI, @unchecked Sendable {
    var responses: [String] = []
    var requested = 0

    func setMealWbtReminder(patientID: String, mealID: String, enabled: Bool) async throws -> MealResponse {
        throw URLError(.badServerResponse)
    }

    func requestMealWbtSuggestion(patientID: String, mealID: String) async throws -> MealWbtSuggestionResponse {
        requested += 1
        return try Self.response(status: "PENDING", result: "null")
    }

    func openMealWbtConversation(patientID: String, mealID: String) async throws -> MealWbtConversationResponse {
        MealWbtConversationResponse(patient_id: patientID, meal_id: mealID, conversation_id: "conv-wbt")
    }

    func getMealWbtSuggestion(patientID: String, mealID: String) async throws -> MealWbtSuggestionResponse {
        let next = responses.isEmpty ? "DONE" : responses.removeFirst()
        return try next == "DONE"
            ? Self.response(status: "DONE", result: #"{"basis":"STANDARD","dose_units":1.4,"carbs_equivalent_g":10,"rationale":"Za mało historii.","history_cases_used":0,"history_cases":[],"extra":1}"#)
            : Self.response(status: next, result: next == "FAILED" ? #"{"error":"X"}"# : "null")
    }

    static func response(status: String, result: String) throws -> MealWbtSuggestionResponse {
        let json = """
        {"patient_id":"p","meal":{"meal_id":"m","status":"CONFIRMED","started_at":"2026-10-15T17:00:00.000Z","source_carbs_g":47,"description":"Nuggetsy","has_photo":false,
         "macros":{"carbs":{"grams":47,"origin":"CAREGIVER"},"protein":{"grams":22.4,"origin":"CAREGIVER"},"fat":{"grams":26.7,"origin":"CAREGIVER"}},
         "pending_proposal_id":null,"proposal_in_progress":false,"trusted":true,
         "wbt":{"fat_protein_units":3.3,"auto_threshold_met":true,"reminder":{"enabled":true,"source":"AUTO","remind_at":"2026-10-15T19:30:00.000Z","status":"SENT"}}},
         "suggestion":{"id":"s","status":"\(status)","result":\(result)}}
        """
        return try JSONDecoder().decode(MealWbtSuggestionResponse.self, from: Data(json.utf8))
    }
}

@MainActor
final class MealWbtViewModelTests: XCTestCase {
    func testRequestPollsUntilTheAnswerIsReady() async {
        let api = FakeWbtAPI()
        api.responses = ["PENDING", "DONE"]
        let viewModel = MealWbtViewModel(route: MealRoute(patientID: "p", mealID: "m", opensWbt: true), api: api, pollInterval: 1_000_000)

        await viewModel.requestSuggestion()

        XCTAssertEqual(api.requested, 1)
        XCTAssertEqual(viewModel.suggestion?.status, "DONE")
        XCTAssertEqual(viewModel.suggestion?.result?.dose_units, 1.4)
        XCTAssertEqual(viewModel.meal?.wbt?.fat_protein_units, 3.3)
        XCTAssertEqual(viewModel.meal?.wbt?.reminder?.status, "SENT")
    }

    func testFailedSuggestionDecodesWithoutResult() async {
        let api = FakeWbtAPI()
        api.responses = ["FAILED"]
        let viewModel = MealWbtViewModel(route: MealRoute(patientID: "p", mealID: "m"), api: api, pollInterval: 1_000_000)

        await viewModel.load()

        XCTAssertEqual(viewModel.suggestion?.status, "FAILED")
        XCTAssertNil(viewModel.suggestion?.result)
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testTalkingTheDoseOverOpensTheMealsConversation() async {
        let viewModel = MealWbtViewModel(route: MealRoute(patientID: "p", mealID: "m"), api: FakeWbtAPI(), pollInterval: 1_000_000)
        await viewModel.openConversation()
        XCTAssertEqual(viewModel.conversationID, "conv-wbt")
    }

    func testAWbtConversationsNewestDoseIsGivenAsTheMealsWbt() throws {
        let json = #"""
        {"id":"c","patient_id":"p","awaiting_user_answer":false,"pending_question":null,"analysis_id":null,"recommendation_id":null,
         "wbt":{"meal_id":"m"},
         "messages":[{"id":"a","role":"ASSISTANT","message_type":"AI_RESPONSE","content":"Mniej.","created_at":"2026-10-25T12:00:00.000Z",
           "wbt_proposal":{"suggestion_id":"s2","meal_id":"m","dose_units":0.5,"carbs_equivalent_g":5,"rationale":"Spada.","warnings":["Glikemia 85 mg/dL"],"newest":true,"command":null}}]}
        """#
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: Data(json.utf8))
        XCTAssertEqual(conversation.wbt?.meal_id, "m")
        let proposal = try XCTUnwrap(conversation.messages.first?.wbt_proposal)

        let card = try XCTUnwrap(MealWbtView.chatCard(proposal))
        XCTAssertEqual(card.purpose, "WBT")
        XCTAssertEqual(card.state, "PROPOSED")
        XCTAssertEqual(card.carbs_g, 5)
        XCTAssertEqual(card.warnings.map(\.message), ["Glikemia 85 mg/dL"])
        let base = try XCTUnwrap(MealWbtView.chatBase(proposal))
        XCTAssertEqual(base.source, .wbtScreen)
        XCTAssertEqual(base.wbtMealID, "m")
        XCTAssertEqual(base.insulinU, Decimal(string: "0.5"))
    }
}
