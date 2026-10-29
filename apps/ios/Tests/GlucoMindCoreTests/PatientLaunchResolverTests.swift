import XCTest
@testable import GlucoMindCore

final class PatientLaunchResolverTests: XCTestCase {
    func testZeroAccessiblePatientsShowsEmptyState() {
        let destination = PatientLaunchResolver.resolve(patients: [])
        XCTAssertEqual(destination, .empty)
    }

    func testExactlyOneAccessiblePatientAutoOpensDashboard() {
        let patient = AccessiblePatient(patient_id: "11111111-1111-4111-8111-111111111111", display_name: "Patient One")
        let destination = PatientLaunchResolver.resolve(patients: [patient])
        XCTAssertEqual(destination, .dashboard(patient))
    }

    func testMultipleAccessiblePatientsShowsSelection() {
        let patientA = AccessiblePatient(patient_id: "11111111-1111-4111-8111-111111111111", display_name: "Zoe")
        let patientB = AccessiblePatient(patient_id: "22222222-2222-4222-8222-222222222222", display_name: "Adam")

        let destination = PatientLaunchResolver.resolve(patients: [patientA, patientB])
        XCTAssertEqual(destination, .selection([patientB, patientA]))
    }

    func testSignedInLaunchPresentsPatientEntry() {
        let state = PatientLaunchResolver.resolveRootPresentation(
            bootstrapped: true,
            hasBootstrapError: false,
            requiresSignIn: false
        )

        XCTAssertEqual(state, .patientEntry)
    }

    func testLoadingErrorAndSignInComeBeforeThePatientsTabs() {
        XCTAssertEqual(PatientLaunchResolver.resolveRootPresentation(bootstrapped: false, hasBootstrapError: false, requiresSignIn: false), .loading)
        XCTAssertEqual(PatientLaunchResolver.resolveRootPresentation(bootstrapped: true, hasBootstrapError: true, requiresSignIn: false), .error)
        XCTAssertEqual(PatientLaunchResolver.resolveRootPresentation(bootstrapped: true, hasBootstrapError: false, requiresSignIn: true), .signIn)
    }

    func testBirthYearIsRequiredOnlyWhenTheServerSendsTheField() throws {
        let decoder = JSONDecoder()
        let older = try decoder.decode(AccessiblePatient.self, from: Data(#"{"patient_id":"p1","display_name":"Ania"}"#.utf8))
        XCTAssertFalse(older.supportsBirthYear)
        XCTAssertFalse(older.needsBirthYear)

        let missing = try decoder.decode(AccessiblePatient.self, from: Data(#"{"patient_id":"p1","display_name":"Ania","birth_year":null}"#.utf8))
        XCTAssertTrue(missing.supportsBirthYear)
        XCTAssertTrue(missing.needsBirthYear)

        let set = try decoder.decode(AccessiblePatient.self, from: Data(#"{"patient_id":"p1","display_name":"Ania","birth_year":2016}"#.utf8))
        XCTAssertEqual(set.birth_year, 2016)
        XCTAssertFalse(set.needsBirthYear)
    }

    func testBirthYearTakesFourDigitsUpToThisYear() {
        let now = ISO8601DateFormatter().date(from: "2026-10-20T12:00:00Z")!
        XCTAssertEqual(PatientBirthYear.parse("2016", now: now), 2016)
        XCTAssertEqual(PatientBirthYear.parse(" 1950 ", now: now), 1950)
        XCTAssertEqual(PatientBirthYear.parse("2026", now: now), 2026)
        XCTAssertNil(PatientBirthYear.parse("2027", now: now))
        XCTAssertNil(PatientBirthYear.parse("1899", now: now))
        XCTAssertNil(PatientBirthYear.parse("216", now: now))
        XCTAssertNil(PatientBirthYear.parse("20a6", now: now))
        XCTAssertNil(PatientBirthYear.parse("", now: now))
    }
}
