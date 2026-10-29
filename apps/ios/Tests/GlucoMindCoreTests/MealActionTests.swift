import XCTest
@testable import GlucoMindCore

@MainActor
final class MealActionTests: XCTestCase {
    func testDecodesTheCardsUnderAnAnswer() async throws {
        let api = MealActionConversationAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-meal", pollInterval: .milliseconds(1))
        await model.loadConversation()

        let answer = try XCTUnwrap(model.conversation?.messages.last)
        let card = try XCTUnwrap(answer.meal_actions?.first)
        XCTAssertEqual(card.title, "Zmiana posiłku · Zupa pomidorowa (13:10)")
        XCTAssertEqual(card.status, "PROPOSED")
        XCTAssertTrue(card.can_apply)
        XCTAssertEqual(card.before.description, "Zupa pomidorowa")
        XCTAssertEqual(card.after.items?.map(\.name), ["Naleśnik", "Twaróg półtłusty"])
        XCTAssertEqual(card.after.carbs_g, 36.3)
        XCTAssertEqual(card.warnings.map(\.code), ["LOOP_CARBS_DIFFER"])
        XCTAssertEqual(card.headline, MealActionHeadline(title: "Zmiana posiłku", chip: "Zupa pomidorowa · 13:10", detail: nil))
        XCTAssertEqual(card.summaryLine.before, "Zupa pomidorowa")
        XCTAssertEqual(card.summaryLine.after, "Naleśnik (120 g), Twaróg półtłusty (60 g)")
        XCTAssertEqual(card.valueChanges.map(\.text), ["W 30 → 36,3 g", "B 10 → 18,9 g", "T 8 → 10,8 g", "WBT 1,1 → 1,7"])
        XCTAssertEqual(card.itemsSummary, "Skład: 2 pozycje · DiabCalc")
        XCTAssertNil(card.decidedLine)
    }

    func testConfirmingSavesOnceAndShowsTheStoredOutcome() async throws {
        let api = MealActionConversationAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-meal", pollInterval: .milliseconds(1))
        await model.loadConversation()
        let card = try XCTUnwrap(model.conversation?.messages.last?.meal_actions?.first)

        await model.applyMealAction(card)

        XCTAssertEqual(api.applyBodies.count, 1)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: api.applyBodies[0]) as? [String: Any])
        // No "Popraw": nothing edited (an absent key, which the server reads as none).
        XCTAssertTrue(sent["edited"] == nil || sent["edited"] is NSNull)
        let refreshed = try XCTUnwrap(model.conversation?.messages.last?.meal_actions?.first)
        XCTAssertEqual(refreshed.status, "APPLIED")
        XCTAssertEqual(refreshed.decidedLine, "Zapisano: Naleśnik (120 g), Twaróg półtłusty (60 g)")
        XCTAssertEqual(refreshed.decided_by, "Piotr")
        XCTAssertTrue(refreshed.can_undo)
        XCTAssertTrue(model.mealActionsInFlight.isEmpty)
        XCTAssertNil(model.mealActionErrors[card.id])
    }

    func testPoprawSendsTheCaregiverValuesWithExplicitNulls() async throws {
        let api = MealActionConversationAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-meal", pollInterval: .milliseconds(1))
        await model.loadConversation()
        let card = try XCTUnwrap(model.conversation?.messages.last?.meal_actions?.first)

        await model.applyMealAction(card, edited: MealActionEdit(description: "Naleśniki z serem", carbs_g: 40, protein_g: nil, fat_g: 10.8))

        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: api.applyBodies[0]) as? [String: Any])
        let edited = try XCTUnwrap(sent["edited"] as? [String: Any])
        XCTAssertEqual(edited["description"] as? String, "Naleśniki z serem")
        XCTAssertEqual(edited["carbs_g"] as? Double, 40)
        XCTAssertTrue(edited["protein_g"] is NSNull)
        XCTAssertEqual(edited["fat_g"] as? Double, 10.8)
    }

    func testAnUndoAfterAnotherChangeSaysWhyNothingHappened() async throws {
        let api = MealActionConversationAPI()
        api.undoStatus = 409
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-meal", pollInterval: .milliseconds(1))
        await model.loadConversation()
        let card = try XCTUnwrap(model.conversation?.messages.last?.meal_actions?.first)

        await model.undoMealAction(card)

        XCTAssertEqual(model.mealActionErrors[card.id], "Posiłek zmienił się od tej zmiany, więc jej nie cofam. Popraw go w zakładce Posiłki.")
    }

    func testCardStatesForTheCaregiver() {
        func card(_ status: String, warnings: [MealActionWarning] = []) -> ConversationMealAction {
            ConversationMealAction(id: "a", user_message_id: "u", operation: "SET_PURPOSE", status: status, title: "t", reason: nil, before: MealActionSide(kind: "PURPOSE", label: "bez odpowiedzi"), after: MealActionSide(kind: "PURPOSE", label: "węgle korekcyjne"), warnings: warnings, meal_id: nil, can_apply: status == "PROPOSED", can_edit: false, can_undo: false, decided_by: nil, decided_at: nil, created_at: "x")
        }
        XCTAssertEqual(card("STALE").decidedLine, "Nieaktualne: posiłek zmienił się w międzyczasie. Poproś o nową propozycję.")
        XCTAssertEqual(card("APPLIED").decidedLine, "Zapisano: węgle korekcyjne")
        XCTAssertEqual(card("REJECTED").decidedLine, "Odrzucono: węgle korekcyjne")
        XCTAssertEqual(card("UNDONE").decidedLine, "Cofnięto: węgle korekcyjne")
        XCTAssertEqual(card("SUPERSEDED").decidedLine, "Zastąpione nowszą propozycją")
        XCTAssertNil(card("APPLYING").decidedLine)
        XCTAssertEqual(card("PROPOSED").summaryLine.before, "bez odpowiedzi")
        XCTAssertEqual(card("PROPOSED").valueChanges, [])
        let noUndo = MealActionWarning(code: "NOT_UNDOABLE", message: "Tej zmiany nie da się cofnąć jednym przyciskiem.")
        XCTAssertEqual(card("PROPOSED", warnings: [noUndo]).visibleWarnings, [noUndo])
        XCTAssertEqual(card("APPLIED", warnings: [noUndo]).visibleWarnings, [])
        XCTAssertEqual(MealActionCard.label(MealActionSide(kind: "WBT_REMINDER", enabled: nil)), "bez przypomnienia o WBT")
    }

    func testCardHeaderAndValuesForOtherChanges() {
        func card(title: String, before: MealActionSide, after: MealActionSide) -> ConversationMealAction {
            ConversationMealAction(id: "a", user_message_id: "u", operation: "UPDATE_MACROS", status: "PROPOSED", title: title, reason: nil, before: before, after: after, warnings: [], meal_id: "m", can_apply: true, can_edit: true, can_undo: false, decided_by: nil, decided_at: nil, created_at: "x")
        }
        let entry = card(title: "Wpis z pętli o 9:05 (18 g węglowodanów i 1,5 j. bolusa)", before: MealActionSide(kind: "PURPOSE", label: "bez odpowiedzi"), after: MealActionSide(kind: "PURPOSE", label: "nowy posiłek"))
        XCTAssertEqual(entry.headline, MealActionHeadline(title: "Wpis z pętli", chip: "9:05", detail: "18 g węglowodanów i 1,5 j. bolusa"))
        XCTAssertEqual(card(title: "Coś innego", before: entry.before, after: entry.after).headline, MealActionHeadline(title: "Coś innego", chip: nil, detail: nil))

        // Values only: the description stays (nothing struck through); unknown values as "?", unchanged ones stay plain.
        let macros = card(title: "Poprawka wartości · Obiad (13:10)",
                          before: MealActionSide(kind: "CONTENT", description: "Skyr", carbs_g: 18, protein_g: nil, fat_g: 4),
                          after: MealActionSide(kind: "CONTENT", description: "Skyr", carbs_g: 18, protein_g: 15, fat_g: 4))
        XCTAssertNil(macros.summaryLine.before)
        XCTAssertEqual(macros.summaryLine.after, "Skyr")
        XCTAssertEqual(macros.valueChanges.map(\.text), ["W 18 g", "B ? → 15 g", "T 4 g"])
        XCTAssertNil(macros.itemsSummary)

        // A description change alone shows no value chips.
        let description = card(title: "Zmiana opisu · Obiad (13:10)",
                               before: MealActionSide(kind: "CONTENT", description: nil, carbs_g: 18),
                               after: MealActionSide(kind: "CONTENT", description: "Skyr", carbs_g: 18))
        XCTAssertNil(description.summaryLine.before)
        XCTAssertEqual(description.valueChanges, [])

        XCTAssertEqual(["1 pozycja", "3 pozycje", "5 pozycji", "12 pozycji", "22 pozycje"], [1, 3, 5, 12, 22].map(MealActionPresentation.itemCount))
    }

    func testMealItemsAndConversationNotesDecode() throws {
        let meal = try JSONDecoder().decode(MealDetail.self, from: Data(#"""
        {"meal_id":"m","status":"CORRECTED","started_at":"2026-10-19T11:10:00.000Z","source_carbs_g":30,"description":"Naleśnik (120 g)","has_photo":false,
         "macros":{"carbs":{"grams":34.2,"origin":"CAREGIVER"},"protein":{"grams":7.8,"origin":"CAREGIVER"},"fat":{"grams":8.4,"origin":"CAREGIVER"}},
         "pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":true,
         "items":[{"name":"Naleśnik","grams":120,"carbs_g":34.2,"protein_g":7.8,"fat_g":8.4,"source":"DIABCALC"}]}
        """#.utf8))
        // The meal's items are no longer shown on the meal: they still come with it without breaking it.
        XCTAssertEqual(meal.description, "Naleśnik (120 g)")
        let note = try JSONDecoder().decode(MealChatMessage.self, from: Data(#"""
        {"id":"n","role":"ASSISTANT","content":"Zmiana z Rozmów: …","photo_ids":[],"proposal":null,"question":null,"author_display_name":"Ewa","reply_to_message_id":null,"origin_conversation_id":"conv-meal","created_at":"x"}
        """#.utf8))
        XCTAssertTrue(note.isConversationNote)
    }
}

@MainActor
private final class MealActionConversationAPI {
    var applied = false
    var undoStatus = 200
    var applyBodies: [Data] = []

    lazy var client: APIClient = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authProvider: MealActionStubAuthProvider(),
        httpClient: MealActionClosureHTTPClient { [unowned self] request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/conversations/conv-meal") && request.httpMethod == "GET" {
                return (Self.conversation(status: self.applied ? "APPLIED" : "PROPOSED"), 200)
            }
            if path.hasSuffix("/meal-actions/action-1/apply") {
                self.applyBodies.append(request.httpBody ?? Data())
                self.applied = true
                return (Data(#"{"patient_id":"patient-1","meal_action":\#(Self.card(status: "APPLIED"))}"#.utf8), 200)
            }
            if path.hasSuffix("/meal-actions/action-1/undo") {
                if self.undoStatus == 409 {
                    return (Data(#"{"type":"https://api.glucomind.local/problems/stale_write","title":"MEAL_CHANGED","status":409,"code":"STALE_WRITE"}"#.utf8), 409)
                }
                return (Data(#"{"patient_id":"patient-1","meal_action":\#(Self.card(status: "UNDONE"))}"#.utf8), 200)
            }
            return (Data(), 404)
        }
    )

    static func card(status: String) -> String {
        let applied = status == "APPLIED"
        return """
        {"id":"action-1","user_message_id":"u1","operation":"REPLACE_CONTENT","status":"\(status)","title":"Zmiana posiłku · Zupa pomidorowa (13:10)",
         "reason":"Zjadł naleśniki zamiast zupy.",
         "before":{"kind":"CONTENT","status":"CONFIRMED","description":"Zupa pomidorowa","items":null,"carbs_g":30,"protein_g":10,"fat_g":8,"fat_protein_units":1.1},
         "after":{"kind":"CONTENT","description":"Naleśnik (120 g), Twaróg półtłusty (60 g)","items":[
            {"name":"Naleśnik","grams":120,"carbs_g":34.2,"protein_g":7.8,"fat_g":8.4,"source":"DIABCALC"},
            {"name":"Twaróg półtłusty","grams":60,"carbs_g":2.1,"protein_g":11.1,"fat_g":2.4,"source":"DIABCALC"}],
            "carbs_g":36.3,"protein_g":18.9,"fat_g":10.8,"fat_protein_units":1.7},
         "warnings":[{"code":"LOOP_CARBS_DIFFER","message":"Pętla dostała 30 g węglowodanów, a zjedzone to 36,3 g."}],
         "meal_id":"meal-1","carb_event_id":null,"loop_action_id":null,
         "can_apply":\(!applied && status == "PROPOSED"),"can_edit":\(status == "PROPOSED"),"can_undo":\(applied),
         "decided_by":\(applied ? #""Piotr""# : "null"),"decided_at":null,"undone_at":null,"created_at":"2026-10-19T12:00:00.000Z"}
        """
    }

    static func conversation(status: String) -> Data {
        Data("""
        {"id":"conv-meal","patient_id":"patient-1","awaiting_user_answer":false,"pending_question":null,"analysis_id":null,"recommendation_id":null,
         "messages":[
           {"id":"u1","role":"USER","message_type":"USER_MESSAGE","content":"Zamiast zupy zjadł naleśniki","question_id":null,"answer_type":null,"answer_text":null,"ai_cost":null,"created_at":"2026-10-19T11:59:00.000Z","response_status":null,"analysis_cancellable":false},
           {"id":"a1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Przygotowałem zmianę obiadu.","question_id":null,"answer_type":null,"answer_text":null,"ai_cost":null,"created_at":"2026-10-19T12:00:00.000Z","response_status":null,"analysis_cancellable":null,
            "meal_actions":[\(card(status: status))]}
         ]}
        """.utf8)
    }
}

private struct MealActionStubAuthProvider: AuthProvider {
    func bearerToken() async throws -> String { "user-1" }
}

private final class MealActionClosureHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (data, response)
    }
}
