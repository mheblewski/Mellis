import XCTest
@testable import GlucoMindCore

private let patientID = "11111111-1111-4111-8111-111111111111"
private let mealID = "22222222-2222-4222-8222-222222222222"
private let planID = "33333333-3333-4333-8333-333333333333"

final class SplitBolusTests: XCTestCase {
    private let mealJSON = """
    {"meal_id":"\(mealID)","status":"CONFIRMED","started_at":"2026-10-20T12:00:00.000Z","source_carbs_g":36,"description":"Pizza margherita (250 g)",
     "has_photo":false,"macros":{"carbs":{"grams":60,"origin":"CAREGIVER"},"protein":{"grams":28,"origin":"CAREGIVER"},"fat":{"grams":32,"origin":"CAREGIVER"}},
     "pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":true,
     "wbt":{"fat_protein_units":4,"auto_threshold_met":true,"reminder":{"enabled":true,"source":"AUTO","remind_at":"2026-10-20T14:30:00.000Z","status":"SCHEDULED"}},
     "planned_bolus":{"id":"\(planID)","status":"SCHEDULED","due_at":"2026-10-20T13:30:00.000Z","delay_minutes":90,"now_percent":60,"carbs_g":24,
       "planned_insulin_u":2.4,"first_carbs_g":36,"first_insulin_u":3.6,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":false}}
    """

    func testThePlannedBolusPushOpensItsCard() {
        let payload: [AnyHashable: Any] = ["gluco": [
            "type": "planned_bolus", "patientId": patientID, "mealId": mealID, "plannedBolusId": planID,
            "routePath": "/patients/\(patientID)/meals/\(mealID)/planned-bolus",
        ]]
        let route = MealLinkParser.parsePushPayload(userInfo: payload)
        // The push names its part: with two parts due, the tap opens this one.
        XCTAssertEqual(route, MealRoute(patientID: patientID, mealID: mealID, opensPlannedBolus: true, plannedBolusID: planID))
        XCTAssertEqual(route?.opensWbt, false)
        XCTAssertNotEqual(route?.id, MealRoute(patientID: patientID, mealID: mealID, opensPlannedBolus: true, plannedBolusID: "44444444-4444-4444-8444-444444444444").id)
        XCTAssertEqual(MealLinkParser.parsePath("/patients/\(patientID)/meals/\(mealID)/planned-bolus"), MealRoute(patientID: patientID, mealID: mealID, opensPlannedBolus: true))
        // Different from the WBT reminder of the same meal (another route, another push in the inbox).
        XCTAssertNotEqual(route?.id, MealRoute(patientID: patientID, mealID: mealID, opensWbt: true).id)
    }

    func testThePlannedPartIsReadByTheIdThePushNamed() async throws {
        let http = PlannedBolusRecordingHTTPClient()
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: http)
        _ = try? await client.getMealPlannedBolus(patientID: patientID, mealID: mealID, plannedBolusID: planID)
        XCTAssertEqual(http.lastURL?.path, "/v1/patients/\(patientID)/meals/\(mealID)/planned-bolus")
        XCTAssertEqual(http.lastURL?.query, "planned_bolus_id=\(planID)")
        _ = try? await client.getMealPlannedBolus(patientID: patientID, mealID: mealID)
        XCTAssertNil(http.lastURL?.query, "without an id: the meal's current part, as before")
    }

    func testTheSecondPartIsGivenForItsPlanWithTheDoseNow() throws {
        let json = """
        {"patient_id":"\(patientID)","meal":\(mealJSON),
         "planned_bolus":{"id":"\(planID)","status":"NOTIFIED","due_at":"2026-10-20T13:30:00.000Z","delay_minutes":90,"now_percent":60,"carbs_g":24,
           "planned_insulin_u":2.4,"first_carbs_g":36,"first_insulin_u":3.6,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":false,
           "meal_started_at":"2026-10-20T12:00:00.000Z","icr_at_plan":10,
           "estimate":{"as_of":"2026-10-20T13:31:00.000Z","icr_g_per_u":8,"insulin_for_carbs_u":3,"loop_extra_u":0.4,"smb_u":0.3,"temp_basal_extra_u":0.1,"insulin_u":2.6},
           "command":null}}
        """
        let response = try JSONDecoder().decode(PlannedBolusResponse.self, from: Data(json.utf8))
        let plan = try XCTUnwrap(response.planned_bolus)
        let base = plan.draftBase()
        XCTAssertEqual(base.source, .plannedBolus)
        XCTAssertEqual(base.plannedBolusID, planID)
        XCTAssertEqual(base.carbsG, 24)
        XCTAssertEqual(base.insulinU, Decimal(string: "2.6"))
        XCTAssertNil(base.meal)
        XCTAssertEqual(PlannedBolusView.reason(plan), "24 g / ICR 8 (przelicznik teraz) = 3 j. Pętla dodała od posiłku 0,4 j ponad bazę (SMB 0,3 j, baza +0,1 j), więc teraz 2,6 j.")
        let card = PlannedBolusView.card(plan, meal: response.meal)
        XCTAssertEqual(card.state, "PROPOSED")
        XCTAssertEqual(card.purpose, "MEAL_PART")
        XCTAssertEqual(card.doseBreakdown, "ICR 8 → 3 j − 0,4 j")
    }

    func testWithoutABasalProfileTheReasonSaysOnlySMBsWereCounted() throws {
        let json = """
        {"patient_id":"\(patientID)","meal":\(mealJSON),
         "planned_bolus":{"id":"\(planID)","status":"NOTIFIED","due_at":"2026-10-20T13:30:00.000Z","delay_minutes":90,"now_percent":60,"carbs_g":24,
           "planned_insulin_u":2.4,"first_carbs_g":36,"first_insulin_u":3.6,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":false,
           "meal_started_at":"2026-10-20T12:00:00.000Z","icr_at_plan":10,
           "estimate":{"as_of":"2026-10-20T13:31:00.000Z","icr_g_per_u":8,"insulin_for_carbs_u":3,"loop_extra_u":0.4,"loop_extra_partial":true,"smb_u":0.4,"temp_basal_extra_u":null,"insulin_u":2.6},
           "command":null}}
        """
        let plan = try XCTUnwrap(try JSONDecoder().decode(PlannedBolusResponse.self, from: Data(json.utf8)).planned_bolus)
        XCTAssertEqual(plan.estimate?.loop_extra_partial, true)
        XCTAssertEqual(PlannedBolusView.reason(plan), "24 g / ICR 8 (przelicznik teraz) = 3 j. Pętla dodała od posiłku 0,4 j ponad bazę (SMB 0,4 j), więc teraz 2,6 j. Bez profilu bazy nie widać zmian bazy (policzone tylko SMB): sprawdź IOB przed podaniem.")
    }

    func testTheConfirmedSecondPartReachesTheServerWithItsPlan() throws {
        let base = RemoteBolusDraftBase(source: .plannedBolus, carbsG: 24, insulinU: Decimal(string: "2.6")!, plannedBolusID: planID)
        XCTAssertEqual(base.with(carbsG: 20, insulinU: Decimal(string: "2.2")!).plannedBolusID, planID)
        let request = RemoteCommandAuthorizeRequest(source: .plannedBolus, carbs_g: 24, insulin_u: Decimal(string: "2.6")!, bolus_step: Decimal(string: "0.05")!, device_id: "d1", conversation_id: nil, proposal_id: nil, meal: nil, planned_bolus_id: planID, acknowledged_warnings: [])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(body["source"] as? String, "PLANNED_BOLUS")
        XCTAssertEqual(body["planned_bolus_id"] as? String, planID)
    }

    func testAChatCardCarriesItsSplit() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":36,"insulin_u":3.6,"icr_g_per_u":10,"icr_insulin_u":3.6,"meal_description":"Pizza","meal":null,
         "reason":"Pizza: część później.","warnings":[],"expires_at":"2026-10-20T12:15:00Z","state":"PROPOSED","command":null,
         "split":{"policy_version":"split-bolus.v1","now_percent":60,"later_after_minutes":90,"total_carbs_g":60,"total_insulin_u":6,"later_carbs_g":24,"later_insulin_u":2.4},
         "planned_bolus":null}
        """
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: Data(json.utf8))
        XCTAssertEqual(card.split?.later_carbs_g, 24)
        XCTAssertNil(card.planned_bolus)
        // The card gives the part now.
        XCTAssertEqual(card.draftBase(conversationID: "c1").carbsG, 36)
    }
}

private final class PlannedBolusRecordingHTTPClient: HTTPClient, @unchecked Sendable {
    var lastURL: URL?
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastURL = request.url
        return (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
