import XCTest
@testable import GlucoMindCore

final class MealPlanChatTests: XCTestCase {
    private let entryJSON = #"{"id":"e1","plan_id":"p1","kind":"MEAL","title":"Podwieczorek","planned_at":"2026-11-10T11:50:00.000Z","items":[{"name":"Batonik zbożowy 25 g","carbs_g":17,"protein_g":1.5,"fat_g":4}],"status":"PLANNED","lead_minutes":20,"menu_changed":true,"plate":{}}"#

    func testTheServersEmptyPlateIsAPlateWithNothingSet() throws {
        let entry = try JSONDecoder().decode(MealPlanEntry.self, from: Data(entryJSON.utf8))
        XCTAssertEqual(entry.plate?.value, MealPlanPlate())
        XCTAssertEqual(entry.menu_changed, true)
    }

    func testAPlateThisAppCannotReadDoesNotBreakTheEntry() throws {
        let odd = entryJSON.replacingOccurrences(of: #""plate":{}"#, with: #""plate":{"foods":"zle"}"#)
        let entry = try JSONDecoder().decode(MealPlanEntry.self, from: Data(odd.utf8))
        XCTAssertNotNil(entry.plate)
        XCTAssertNil(entry.plate?.value)
    }

    func testAPlateGoesToTheServerAndBack() throws {
        var plate = MealPlanPlate()
        plate.set(.init(portion: .half), for: MealPlanItem(name: "Kisiel", carbs_g: 22))
        plate.add(name: "Bułka", grams: 20)
        let back = try JSONDecoder().decode(MealPlanPlate.self, from: JSONEncoder().encode(plate))
        XCTAssertEqual(back, plate)
    }

    func testTheChatShowsTheLatestProposalAcceptedOnlyAfterItsAcceptance() throws {
        let proposal = #"{"items":[{"name":"Batonik","grams":25,"carbs_g":17,"protein_g":1.5,"fat_g":4,"source":"ESTIMATE"}],"carbs_g":17,"protein_g":1.5,"fat_g":4,"confidence":"MEDIUM","assumptions":"","proposal_id":null}"#
        func response(acceptedAt: String) -> String {
            #"{"patient_id":"pt","entry":\#(entryJSON),"messages":[{"id":"u1","role":"USER","content":"zamiast kisielu batonik","photo_ids":[],"proposal":null,"question":null,"author_display_name":null,"reply_to_message_id":null,"accepted_at":null,"created_at":"2026-11-10T10:00:00.000Z"},{"id":"a1","role":"ASSISTANT","content":"Zamieniam.","photo_ids":[],"proposal":\#(proposal),"question":null,"author_display_name":null,"reply_to_message_id":"u1","accepted_at":\#(acceptedAt),"created_at":"2026-11-10T10:00:05.000Z"}],"reply_pending":false,"reply_failed":false}"#
        }
        let open = try JSONDecoder().decode(MealPlanChatResponse.self, from: Data(response(acceptedAt: "null").utf8)).asMealChat
        XCTAssertFalse(open.meal.trusted)
        XCTAssertEqual(open.messages.count, 2)
        let accepted = try JSONDecoder().decode(MealPlanChatResponse.self, from: Data(response(acceptedAt: #""2026-11-10T10:01:00.000Z""#).utf8)).asMealChat
        XCTAssertTrue(accepted.meal.trusted)
        XCTAssertEqual(accepted.meal.macros.carbs.grams, 17)
    }
}
