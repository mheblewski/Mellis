import XCTest
@testable import GlucoMindCore

private let patientID = "11111111-1111-4111-8111-111111111111"
private let mealID = "22222222-2222-4222-8222-222222222222"

final class MealRoutingTests: XCTestCase {
    func testMealPushPayloadOpensMealRoute() {
        let payload: [AnyHashable: Any] = [
            "gluco": [
                "type": "meal_description",
                "patientId": patientID,
                "mealId": mealID,
                "routePath": "/patients/\(patientID)/meals/\(mealID)",
                "universalLink": "https://app.mellis.invalid/patients/\(patientID)/meals/\(mealID)",
            ],
        ]

        XCTAssertEqual(MealLinkParser.parsePushPayload(userInfo: payload), MealRoute(patientID: patientID, mealID: mealID))
        // A meal push is never mistaken for a conversation question.
        XCTAssertNil(PushPayloadParser.parseConversationRoute(userInfo: payload))
    }

    func testMealPushPayloadFallsBackToRoutePath() {
        let payload: [AnyHashable: Any] = ["gluco": ["type": "meal_description", "routePath": "/patients/\(patientID)/meals/\(mealID)"]]
        XCTAssertEqual(MealLinkParser.parsePushPayload(userInfo: payload), MealRoute(patientID: patientID, mealID: mealID))
    }

    func testWbtReminderPushOpensTheWbtScreenOfTheMeal() {
        let payload: [AnyHashable: Any] = [
            "gluco": [
                "type": "wbt_reminder",
                "patientId": patientID,
                "mealId": mealID,
                "routePath": "/patients/\(patientID)/meals/\(mealID)/wbt",
            ],
        ]
        XCTAssertEqual(MealLinkParser.parsePushPayload(userInfo: payload), MealRoute(patientID: patientID, mealID: mealID, opensWbt: true))
        let pathOnly: [AnyHashable: Any] = ["gluco": ["type": "wbt_reminder", "routePath": "/patients/\(patientID)/meals/\(mealID)/wbt"]]
        XCTAssertEqual(MealLinkParser.parsePushPayload(userInfo: pathOnly), MealRoute(patientID: patientID, mealID: mealID, opensWbt: true))
        XCTAssertNil(MealLinkParser.parsePath("/patients/\(patientID)/meals/\(mealID)/other"))
    }

    func testConversationPushIsNotAMealRoute() {
        let payload: [AnyHashable: Any] = ["gluco": ["type": "conversation_question", "patientId": patientID, "conversationId": mealID]]
        XCTAssertNil(MealLinkParser.parsePushPayload(userInfo: payload))
    }

    func testMealUniversalLinkParsingAndRejection() {
        XCTAssertEqual(MealLinkParser.parse(URL(string: "https://app.mellis.invalid/patients/\(patientID)/meals/\(mealID)")!), MealRoute(patientID: patientID, mealID: mealID))
        XCTAssertNil(MealLinkParser.parse(URL(string: "https://evil.example.com/patients/\(patientID)/meals/\(mealID)")!))
        XCTAssertNil(MealLinkParser.parse(URL(string: "http://app.mellis.invalid/patients/\(patientID)/meals/\(mealID)")!))
        XCTAssertNil(MealLinkParser.parsePath("/patients/\(patientID)/meals/not-a-uuid"))
        XCTAssertNil(UniversalLinkParser.parse(URL(string: "https://app.mellis.invalid/patients/\(patientID)/meals/\(mealID)")!))
    }

    @MainActor
    func testMealLinksRouteSeparatelyFromConversations() {
        let navigator = RouteRecorder()
        navigator.handle(universalLink: URL(string: "https://app.mellis.invalid/patients/\(patientID)/meals/\(mealID)")!)
        XCTAssertEqual(navigator.mealRoute, MealRoute(patientID: patientID, mealID: mealID))
        XCTAssertNil(navigator.route)
    }

    @MainActor
    func testCoordinatorOpensMealOnlyForAccessiblePatient() async {
        let access = PatientAccessResolver(api: MealAccessStub(allowed: [patientID]))
        var opened: [AppRoute] = []
        let coordinator = PendingRouteCoordinator(
            isSignedIn: { true },
            knownPatientIDs: { [] },
            refreshPatientIDs: { Array(try await access.refreshAccessiblePatientIDs()) },
            deliver: { opened.append($0) }
        )

        await coordinator.receive(.meal(MealRoute(patientID: "33333333-3333-4333-8333-333333333333", mealID: mealID)))
        XCTAssertTrue(opened.isEmpty)

        await coordinator.receive(.meal(MealRoute(patientID: patientID, mealID: mealID)))
        XCTAssertEqual(opened, [.meal(MealRoute(patientID: patientID, mealID: mealID))])
    }
}

final class MealAPIClientTests: XCTestCase {
    func testDecodesProposalFailedAndToleratesItsAbsence() throws {
        let failed = try JSONDecoder().decode(MealResponse.self, from: StubMealAPI.json(status: "DESCRIBED", proposalFailed: true))
        XCTAssertEqual(failed.meal.proposal_failed, true)
        XCTAssertFalse(failed.meal.proposal_in_progress)

        let pending = try JSONDecoder().decode(MealResponse.self, from: StubMealAPI.json(status: "DESCRIBED"))
        XCTAssertEqual(pending.meal.proposal_failed, false)
        XCTAssertTrue(pending.meal.proposal_in_progress)

        let legacy = try JSONDecoder().decode(MealResponse.self, from: StubMealAPI.json(status: "DESCRIBED", proposalFailed: nil))
        XCTAssertNil(legacy.meal.proposal_failed)
        XCTAssertTrue(legacy.meal.proposal_in_progress)
    }

    func testCorrectionEncodesExplicitNulls() async throws {
        let http = RecordingHTTPClient(data: StubMealAPI.json(status: "CORRECTED"))
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authorizationMode: .none, httpClient: http)

        _ = try await client.correctMeal(patientID: patientID, mealID: mealID, carbsG: 40, proteinG: nil, fatG: nil)

        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(http.lastRequest?.httpBody)) as? [String: Any])
        XCTAssertEqual(json["carbs_g"] as? Double, 40)
        XCTAssertTrue(json["protein_g"] is NSNull)
        XCTAssertEqual(http.lastRequest?.url?.path, "/v1/patients/\(patientID)/meals/\(mealID)/correct")
    }
}

private final class StubMealAPI: MealAPI {
    var status = "AWAITING_DESCRIPTION"
    var corrected: (carbs: Double?, protein: Double?, fat: Double?)?
    var getError: APIClientError?
    var pollsUntilProposal = 2
    private(set) var getMealCalls = 0

    /// `proposalFailed: nil` omits the field, as older servers do.
    static func json(status: String, carbs: Double? = nil, origin: String? = nil, proposalFailed: Bool? = false) -> Data {
        let carbsJSON = carbs.map { "{\"grams\":\($0),\"origin\":\"\(origin ?? "AI_PROPOSAL")\"}" } ?? "{\"grams\":null,\"origin\":null}"
        let proposalID = status == "AI_PROPOSED" ? "\"proposal-1\"" : "null"
        let trusted = status == "CONFIRMED" || status == "CORRECTED"
        let failedJSON = proposalFailed.map { "\"proposal_failed\":\($0)," } ?? ""
        return """
        {"patient_id":"\(patientID)","meal":{"meal_id":"\(mealID)","status":"\(status)","started_at":"2026-11-01T12:00:00.000Z",
        "source_carbs_g":45,"description":null,"has_photo":false,
        "macros":{"carbs":\(carbsJSON),"protein":{"grams":null,"origin":null},"fat":{"grams":null,"origin":null}},
        "pending_proposal_id":\(proposalID),"proposal_in_progress":\(status == "DESCRIBED" && proposalFailed != true),\(failedJSON)"trusted":\(trusted)}}
        """.data(using: .utf8)!
    }

    private func response() throws -> MealResponse {
        let carbs: Double? = status == "AI_PROPOSED" || status == "CONFIRMED" ? 45 : (status == "CORRECTED" ? corrected?.carbs : nil)
        return try JSONDecoder().decode(MealResponse.self, from: Self.json(status: status, carbs: carbs, origin: status == "CORRECTED" ? "CAREGIVER" : "AI_PROPOSAL"))
    }

    func getMeal(patientID: String, mealID: String) async throws -> MealResponse {
        getMealCalls += 1
        if let getError { throw getError }
        if status == "DESCRIBED" {
            pollsUntilProposal -= 1
            if pollsUntilProposal <= 0 { status = "AI_PROPOSED" }
        }
        return try response()
    }

    func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?) async throws -> MealResponse {
        corrected = (carbsG, proteinG, fatG)
        status = "CORRECTED"
        return try response()
    }
}

private final class RecordingHTTPClient: HTTPClient {
    let data: Data
    var lastRequest: URLRequest?

    init(data: Data) {
        self.data = data
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private final class MealAccessStub: PatientAccessListing {
    let allowed: [String]

    init(allowed: [String]) {
        self.allowed = allowed
    }

    func listAccessiblePatients() async throws -> AccessiblePatientsResponse {
        AccessiblePatientsResponse(user_id: "user-1", patients: allowed.map { AccessiblePatient(patient_id: $0, display_name: "Patient") })
    }
}
