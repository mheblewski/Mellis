import XCTest
@testable import GlucoMindCore

/// The year-of-birth screen before the tabs only for someone who can save it (2026-11-16).
final class BirthYearPromptTests: XCTestCase {
    private func decode(_ json: String) throws -> AccessiblePatient {
        try JSONDecoder().decode(AccessiblePatient.self, from: Data(json.utf8))
    }

    func testOwnerWithoutYearIsAsked() throws {
        let patient = try decode(#"{"patient_id":"p1","display_name":"Ewa","birth_year":null,"is_owner":true}"#)
        XCTAssertTrue(patient.asksForBirthYear)
    }

    func testMemberWhoIsNotAnOwnerIsNotStuckOnTheForm() throws {
        let patient = try decode(#"{"patient_id":"p1","display_name":"Ewa","birth_year":null,"is_owner":false}"#)
        XCTAssertTrue(patient.needsBirthYear)
        XCTAssertFalse(patient.asksForBirthYear)
    }

    func testOlderServerWithoutOwnerFieldStillAsks() throws {
        let patient = try decode(#"{"patient_id":"p1","display_name":"Ewa","birth_year":null}"#)
        XCTAssertTrue(patient.asksForBirthYear)
    }

    func testYearSetOrUnsupportedIsNeverAsked() throws {
        XCTAssertFalse(try decode(#"{"patient_id":"p1","display_name":"Ewa","birth_year":2019,"is_owner":true}"#).asksForBirthYear)
        XCTAssertFalse(try decode(#"{"patient_id":"p1","display_name":"Ewa","is_owner":true}"#).asksForBirthYear)
    }

    func testOwnerFlagSurvivesTheCache() throws {
        let patient = try decode(#"{"patient_id":"p1","display_name":"Ewa","birth_year":null,"is_owner":false}"#)
        let again = try JSONDecoder().decode(AccessiblePatient.self, from: JSONEncoder().encode(patient))
        XCTAssertEqual(again.is_owner, false)
        XCTAssertFalse(again.asksForBirthYear)
    }
}
