import XCTest
@testable import GlucoMindCore

final class UserAiPreferencesTests: XCTestCase {
    func testDecodesRoleAndTextAndReadsUnknownRoleAsNotChosen() throws {
        let decoder = JSONDecoder()
        let set = try decoder.decode(UserAiPreferences.self, from: Data(#"{"ai_role":"PATIENT_SELF","ai_instructions":"Krótko."}"#.utf8))
        XCTAssertEqual(set, UserAiPreferences(role: .patientSelf, instructions: "Krótko."))
        XCTAssertEqual(set.summary, "Jestem pacjentem")

        let empty = try decoder.decode(UserAiPreferences.self, from: Data(#"{"ai_role":null,"ai_instructions":null}"#.utf8))
        XCTAssertTrue(empty.isEmpty)
        XCTAssertEqual(empty.summary, "Nie ustawiono")

        let newer = try decoder.decode(UserAiPreferences.self, from: Data(#"{"ai_role":"DIETITIAN","ai_instructions":"Bez żargonu."}"#.utf8))
        XCTAssertNil(newer.role)
        XCTAssertEqual(newer.summary, "Własne instrukcje")
    }

    func testEncodesBothKeysWithNullForClearedValuesAndTrimsTheText() throws {
        let cleared = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UserAiPreferences(role: nil, instructions: "  \n "))) as? [String: Any]
        XCTAssertEqual(cleared?.keys.sorted(), ["ai_instructions", "ai_role"])
        XCTAssertTrue(cleared?["ai_role"] is NSNull)
        XCTAssertTrue(cleared?["ai_instructions"] is NSNull)

        let set = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UserAiPreferences(role: .grandparent, instructions: " Tłumacz prosto. "))) as? [String: Any]
        XCTAssertEqual(set?["ai_role"] as? String, "GRANDPARENT")
        XCTAssertEqual(set?["ai_instructions"] as? String, "Tłumacz prosto.")
    }

    func testCountsCharactersAsTheServerDoes() {
        XCTAssertEqual(UserAiPreferences.characterCount("  abc \n"), 3)
        XCTAssertEqual(UserAiPreferences.characterCount("🙂🙂"), 2)
        XCTAssertFalse(UserAiPreferences(instructions: String(repeating: "a", count: 500)).isInstructionsTooLong)
        XCTAssertTrue(UserAiPreferences(instructions: String(repeating: "a", count: 501)).isInstructionsTooLong)
    }

    func testPolishLabelsForEveryRole() {
        XCTAssertEqual(AiUserRole.allCases.map(\.label), [
            "Rodzic", "Babcia lub dziadek", "Opiekun w placówce", "Jestem pacjentem", "Lekarz lub pielęgniarka", "Inna osoba",
        ])
    }

    func testTheNextExampleReplacesThePreviousOneAndChoosesItsRole() throws {
        let newDiagnosis = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "new-diagnosis" })
        let clinician = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "clinician" })

        let first = UserAiPreferences(role: .parent).applying(newDiagnosis)
        XCTAssertEqual(first.role, .parent)
        XCTAssertEqual(first.instructions, newDiagnosis.text)
        XCTAssertEqual(first.applying(newDiagnosis), first)

        let second = first.applying(clinician)
        XCTAssertEqual(second.role, .clinician)
        XCTAssertEqual(second.instructions, clinician.text)
    }

    func testAnExampleIsSelectedOnlyWhileItsTextIsInTheField() throws {
        let newDiagnosis = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "new-diagnosis" })

        let chosen = UserAiPreferences(role: .parent, instructions: "Mamy 3-latka.").applying(newDiagnosis)
        XCTAssertEqual(chosen.selectedExample, newDiagnosis)

        // Edited by hand: no longer the example's text.
        let edited = UserAiPreferences(role: .parent, instructions: chosen.instructions.replacingOccurrences(of: "prosto", with: "krótko"))
        XCTAssertNil(edited.selectedExample)
        XCTAssertNil(UserAiPreferences(role: .parent, instructions: "Mamy 3-latka.").selectedExample)
    }

    func testTappingTheSelectedExampleAgainTakesItsTextOut() throws {
        let clinician = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "clinician" })
        let chosen = UserAiPreferences(role: .parent, instructions: "Pracuję w szpitalu.").applying(clinician)
        let removed = chosen.removingExample()
        XCTAssertEqual(removed.instructions, "Pracuję w szpitalu.")
        XCTAssertEqual(removed.role, .clinician)
        XCTAssertNil(removed.selectedExample)
    }

    func testTakingAnExampleBackGivesTheUsersRoleBack() throws {
        let clinician = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "clinician" })
        let newDiagnosis = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "new-diagnosis" })
        var memory = AiExampleRoleMemory()

        // A tap by mistake on "Jestem lekarzem", then tapped again.
        XCTAssertEqual(memory.roleAfterApplying(clinician, current: .parent), .clinician)
        XCTAssertEqual(memory.roleAfterRemovingExample(current: .clinician), .parent)

        // From "Jestem lekarzem" to an example without a role: the parent's role is back.
        XCTAssertEqual(memory.roleAfterApplying(clinician, current: .parent), .clinician)
        XCTAssertEqual(memory.roleAfterApplying(newDiagnosis, current: .clinician), .parent)

        // No role chosen before: "Nie wybrano" comes back.
        XCTAssertEqual(memory.roleAfterApplying(clinician, current: nil), .clinician)
        XCTAssertNil(memory.roleAfterRemovingExample(current: .clinician))
    }

    func testARoleChosenByHandStays() throws {
        let clinician = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "clinician" })
        var memory = AiExampleRoleMemory()
        _ = memory.roleAfterApplying(clinician, current: .parent)
        memory.userChoseRole()
        XCTAssertEqual(memory.roleAfterRemovingExample(current: .grandparent), .grandparent)
    }

    func testTheUsersOwnWordsStayWhenAnExampleChanges() throws {
        let newDiagnosis = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "new-diagnosis" })
        let support = try XCTUnwrap(AiInstructionExample.all.first { $0.id == "support" })

        let own = UserAiPreferences(role: .parent, instructions: "Mamy 3-latka.").applying(newDiagnosis)
        XCTAssertEqual(own.instructions, "Mamy 3-latka.\n" + newDiagnosis.text)
        XCTAssertEqual(own.applying(support).instructions, "Mamy 3-latka.\n" + support.text)
    }

    func testEveryExampleFitsTheLimit() {
        XCTAssertFalse(AiInstructionExample.all.isEmpty)
        for example in AiInstructionExample.all {
            XCTAssertLessThanOrEqual(UserAiPreferences.characterCount(example.text), UserAiPreferences.maxInstructionsLength)
        }
    }

    func testGetsAndPutsTheSignedInUsersPreferences() async throws {
        let http = PreferencesHTTPClient(data: Data(#"{"ai_role":"CLINICIAN","ai_instructions":"Mów jak do lekarza."}"#.utf8))
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: PreferencesAuthProvider(), httpClient: http)

        let loaded = try await client.getUserAiPreferences()
        XCTAssertEqual(loaded.role, .clinician)
        XCTAssertEqual(http.requests.last?.httpMethod, "GET")
        XCTAssertEqual(http.requests.last?.url?.path, "/v1/me/ai-preferences")

        _ = try await client.setUserAiPreferences(UserAiPreferences(role: .clinician, instructions: "Mów jak do lekarza."))
        XCTAssertEqual(http.requests.last?.httpMethod, "PUT")
        XCTAssertEqual(http.requests.last?.url?.path, "/v1/me/ai-preferences")
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(http.requests.last?.httpBody)) as? [String: Any]
        XCTAssertEqual(body?["ai_role"] as? String, "CLINICIAN")
    }
}

private struct PreferencesAuthProvider: AuthProvider {
    func bearerToken() async throws -> String { "user-1" }
}

private final class PreferencesHTTPClient: HTTPClient, @unchecked Sendable {
    let data: Data
    var requests: [URLRequest] = []

    init(data: Data) {
        self.data = data
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
