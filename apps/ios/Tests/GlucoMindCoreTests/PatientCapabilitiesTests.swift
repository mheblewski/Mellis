import XCTest
@testable import GlucoMindCore

final class PatientCapabilitiesTests: XCTestCase {
    func testDecodesTheServerAnswer() throws {
        let json = #"{"patient_id":"p1","remote_commands":{"enabled":true,"reason":"ENABLED"}}"#.data(using: .utf8)!
        let response = try JSONDecoder().decode(PatientCapabilitiesResponse.self, from: json)
        XCTAssertEqual(response.remote_commands, RemoteCommandsAccess(enabled: true, reason: "ENABLED"))
    }

    func testReadsTheMonthlyAiLimit() throws {
        let json = #"{"patient_id":"p1","remote_commands":{"enabled":false,"reason":"SERVER_DISABLED"},"ai":{"limit_reached":true,"resets_at":"2026-10-31T23:00:00.000Z"}}"#.data(using: .utf8)!
        let response = try JSONDecoder().decode(PatientCapabilitiesResponse.self, from: json)
        XCTAssertEqual(response.ai, AiLimitStatus(limit_reached: true, resets_at: "2026-10-31T23:00:00.000Z"))
        XCTAssertEqual(
            response.ai?.notice(timeZone: TimeZone(identifier: "Europe/Warsaw")!),
            "Limit AI na ten miesiąc wyczerpany. Odnowi się 1 listopada. Zmienisz go na serwerze: mellis → Zmień ustawienia → Limit AI."
        )
        XCTAssertNil(AiLimitStatus(limit_reached: false, resets_at: "2026-10-31T23:00:00.000Z").notice())
        // A server before the field (or without paid AI) says nothing.
        let old = try JSONDecoder().decode(PatientCapabilitiesResponse.self, from: #"{"patient_id":"p1","remote_commands":{"enabled":false,"reason":"X"},"ai":null}"#.data(using: .utf8)!)
        XCTAssertNil(old.ai)
    }

    @MainActor
    func testStaysOffUntilTheServerSaysOtherwise() async {
        let api = StubCapabilitiesAPI()
        let store = PatientCapabilitiesStore()
        XCTAssertFalse(store.remoteCommands.enabled)

        api.answer = .success(.init(patient_id: "p1", remote_commands: .init(enabled: true, reason: "ENABLED")))
        await store.refresh(api: api, patientID: "p1")
        XCTAssertTrue(store.remoteCommands.enabled)

        // A network error keeps the last answer.
        api.answer = .failure(URLError(.notConnectedToInternet))
        await store.refresh(api: api, patientID: "p1")
        XCTAssertTrue(store.remoteCommands.enabled)

        api.answer = .success(.init(patient_id: "p1", remote_commands: .init(enabled: false, reason: "PATIENT_DISABLED")))
        await store.refresh(api: api, patientID: "p1")
        XCTAssertFalse(store.remoteCommands.enabled)
    }

    @MainActor
    func testAnotherPatientStartsOff() async {
        let api = StubCapabilitiesAPI()
        let store = PatientCapabilitiesStore()
        api.answer = .success(.init(patient_id: "p1", remote_commands: .init(enabled: true, reason: "ENABLED")))
        await store.refresh(api: api, patientID: "p1")

        // The second patient's answer fails: nothing from the first patient stays on.
        api.answer = .failure(URLError(.timedOut))
        await store.refresh(api: api, patientID: "p2")
        XCTAssertFalse(store.remoteCommands.enabled)

        // An answer for a different patient than asked is ignored.
        api.answer = .success(.init(patient_id: "p1", remote_commands: .init(enabled: true, reason: "ENABLED")))
        await store.refresh(api: api, patientID: "p2")
        XCTAssertFalse(store.remoteCommands.enabled)
    }

    @MainActor
    func testKnowsThePatientsLoopAndForgetsItForAnotherPatient() async throws {
        let json = #"{"patient_id":"p1","loop_system":{"kind":"LOOP","version":"3.14.11"},"remote_commands":{"enabled":false,"reason":"LOOP_SYSTEM_NOT_SUPPORTED"}}"#.data(using: .utf8)!
        let response = try JSONDecoder().decode(PatientCapabilitiesResponse.self, from: json)
        XCTAssertEqual(response.loop_system?.system, .loop)
        XCTAssertEqual(response.loop_system?.displayName, "Loop 3.14.11")
        XCTAssertEqual(response.remote_commands.explanation, "Pętla tego pacjenta nie przyjmuje jeszcze poleceń z aplikacji Mellis (na razie tylko Trio).")

        let api = StubCapabilitiesAPI()
        let store = PatientCapabilitiesStore()
        api.answer = .success(response)
        await store.refresh(api: api, patientID: "p1")
        XCTAssertEqual(store.loopSystem.system, .loop)
        api.answer = .failure(URLError(.timedOut))
        await store.refresh(api: api, patientID: "p2")
        XCTAssertEqual(store.loopSystem, .unknown)
    }

    func testAnOlderServerOrAnUnknownKindReadsAsAnUnknownLoop() throws {
        let old = try JSONDecoder().decode(PatientCapabilitiesResponse.self, from: Data(#"{"patient_id":"p1","remote_commands":{"enabled":true,"reason":"ENABLED"}}"#.utf8))
        XCTAssertNil(old.loop_system)
        XCTAssertEqual(LoopSystemInfo(kind: "SOMETHING_NEW", version: nil).system, .unknown)
        XCTAssertNil(LoopSystemInfo.unknown.displayName)
        XCTAssertEqual(LoopSystemInfo(kind: "TRIO", version: nil).displayName, "Trio")
    }

    func testNamesTheLoopInTheFormsPolishTextsNeed() {
        XCTAssertEqual(LoopSystemKind.trio.names, LoopSystemNames(nominative: "Trio", locative: "Trio", genitive: "Trio", accusative: "Trio", gender: .neuter))
        XCTAssertEqual(LoopSystemKind.loop.names, LoopSystemNames(nominative: "Loop", locative: "Loopie", genitive: "Loopa", accusative: "Loop", gender: .masculine))
        XCTAssertEqual(LoopSystemKind.loop.names.agree(m: "rozpoczął", f: "rozpoczęła", n: "rozpoczęło"), "rozpoczął")
        XCTAssertEqual(LoopSystemKind.unknown.names.capitalized, "Pętla")
        XCTAssertEqual(LoopSystemKind.unknown.names.accusative, "pętlę")
    }

    func testUnknownReasonReadsAsOffWithAnExplanation() {
        XCTAssertEqual(RemoteCommandsAccess.off.explanation, "Nie udało się sprawdzić uprawnień.")
        XCTAssertEqual(RemoteCommandsAccess(enabled: false, reason: "CAREGIVER_NOT_PERMITTED").explanation, "Twoje konto nie ma uprawnienia do zdalnych poleceń dla tego pacjenta.")
    }
}

private final class StubCapabilitiesAPI: PatientCapabilitiesAPI {
    var answer: Result<PatientCapabilitiesResponse, Error> = .failure(URLError(.badServerResponse))

    func getCapabilities(patientID: String) async throws -> PatientCapabilitiesResponse {
        try answer.get()
    }
}
