import XCTest
@testable import GlucoMindCore

@MainActor
final class TrioRemoteSettingsViewModelTests: XCTestCase {
    private let identity = GlucoMindPushIdentity(bundleID: "pl.glucomind.ios", teamID: "TEAM123456", productionEnvironment: false)

    private func target(team: String) -> TrioRemoteTargetResponse {
        TrioRemoteTargetResponse(patient_id: "p1", trio: TrioRemoteTarget(status: "READY", device_token: "ab", bundle_id: "org.nightscout.\(team).trio", team_id: team, apns_environment: "production", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil))
    }

    func testSameTeamNeedsOneKey() async {
        let api = StubTrioAPI(response: target(team: "TEAM123456"))
        let viewModel = TrioRemoteSettingsViewModel(patientID: "p1", api: api, store: InMemoryTrioRemoteSettingsStore(), identity: identity)
        await viewModel.refreshTarget()
        XCTAssertFalse(viewModel.needsReturnKey)
    }

    func testAnotherTeamAsksForGlucoMindsKey() async {
        let api = StubTrioAPI(response: target(team: "ABCDE12345"))
        let viewModel = TrioRemoteSettingsViewModel(patientID: "p1", api: api, store: InMemoryTrioRemoteSettingsStore(), identity: identity)
        await viewModel.refreshTarget()
        XCTAssertTrue(viewModel.needsReturnKey)
        XCTAssertTrue(viewModel.problems.contains { $0.contains("TEAM123456") })
    }

    func testSavesTrimmedSettingsOnlyForThisPatient() async throws {
        let store = InMemoryTrioRemoteSettingsStore()
        let viewModel = TrioRemoteSettingsViewModel(patientID: "p1", api: StubTrioAPI(response: target(team: "TEAM123456")), store: store, identity: identity)
        await viewModel.refreshTarget()
        viewModel.settings.sharedSecret = "  secret \n"
        viewModel.settings.apnsKeyID = "key1234567"
        viewModel.settings.returnKeyID = "OTHER12345"
        viewModel.save()
        let saved = try XCTUnwrap(try store.load(patientID: "p1"))
        XCTAssertEqual(saved.sharedSecret, "secret")
        XCTAssertEqual(saved.apnsKeyID, "KEY1234567")
        XCTAssertNil(saved.returnKeyID, "the same team needs no second key")
        XCTAssertNil(try store.load(patientID: "p2"))

        viewModel.clear()
        XCTAssertNil(try store.load(patientID: "p1"))
        XCTAssertFalse(viewModel.hasStoredSettings)
    }

    func testRefusedTargetShowsAnError() async {
        let viewModel = TrioRemoteSettingsViewModel(patientID: "p1", api: StubTrioAPI(response: nil), store: InMemoryTrioRemoteSettingsStore(), identity: identity)
        await viewModel.refreshTarget()
        XCTAssertNil(viewModel.target)
        XCTAssertNotNil(viewModel.targetError)
    }

    func testValuesAreSavedAsTheyAreTyped() async {
        let store = InMemoryTrioRemoteSettingsStore()
        let first = TrioRemoteSettingsViewModel(patientID: "draft-p1", api: StubTrioAPI(response: nil), store: store, identity: identity)
        first.settings.sharedSecret = "typed "
        // The app went to Notes and back; iOS rebuilt the screen.
        let second = TrioRemoteSettingsViewModel(patientID: "draft-p1", api: StubTrioAPI(response: nil), store: store, identity: identity)
        XCTAssertEqual(second.settings.sharedSecret, "typed")
        XCTAssertFalse(second.hasUnsavedChanges)
        let third = TrioRemoteSettingsViewModel(patientID: "draft-p2", api: StubTrioAPI(response: nil), store: store, identity: identity)
        XCTAssertEqual(third.settings.sharedSecret, "", "another patient starts empty")
    }

    func testTrioIsRememberedAtSetupAndConfirmedAgainOnlyWhenItChanges() async throws {
        let store = InMemoryTrioRemoteSettingsStore()
        let api = StubTrioAPI(response: target(team: "TEAM123456"))
        let viewModel = TrioRemoteSettingsViewModel(patientID: "p1", patientName: "Franciszek", api: api, store: store, identity: identity)
        // Setting up: the Trio in this patient's Nightscout is remembered without a question.
        await viewModel.refreshTarget()
        XCTAssertEqual(viewModel.pin, .confirmed)
        XCTAssertNotEqual(viewModel.nextStep, .trio)
        XCTAssertNotNil(try store.load(patientID: "p1")?.pinnedTrio)

        // Trio reinstalled: a new token in Nightscout.
        let moved = TrioRemoteSettingsViewModel(patientID: "p1", patientName: "Franciszek", api: StubTrioAPI(response: TrioRemoteTargetResponse(patient_id: "p1", trio: TrioRemoteTarget(status: "READY", device_token: "cd", bundle_id: "org.nightscout.TEAM123456.trio", team_id: "TEAM123456", apns_environment: "production", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil))), store: store, identity: identity)
        await moved.refreshTarget()
        XCTAssertEqual(moved.pin, .changed)
        moved.confirmTrio()
        XCTAssertEqual(moved.pin, .confirmed)

        // That Trio cannot be confirmed for a second patient on this phone.
        let other = TrioRemoteSettingsViewModel(patientID: "p2", api: StubTrioAPI(response: TrioRemoteTargetResponse(patient_id: "p2", trio: TrioRemoteTarget(status: "READY", device_token: "cd", bundle_id: "org.nightscout.TEAM123456.trio", team_id: "TEAM123456", apns_environment: "production", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil))), store: store, identity: identity)
        await other.refreshTarget()
        XCTAssertEqual(other.pin, .usedByOtherPatient)
        other.confirmTrio()
        XCTAssertNil(other.settings.pinnedTrio)
    }

    func testAnotherPatientsSecretIsNotSaved() async throws {
        let store = InMemoryTrioRemoteSettingsStore()
        try store.save(TrioRemoteSettings(sharedSecret: "family-secret"), patientID: "p2")
        let viewModel = TrioRemoteSettingsViewModel(patientID: "p1", api: StubTrioAPI(response: nil), store: store, identity: identity)
        viewModel.settings.sharedSecret = "family-secret"
        XCTAssertEqual(viewModel.saveError, TrioPatientGuard.secretMessage)
        XCTAssertNil(try store.load(patientID: "p1"))
        XCTAssertFalse(viewModel.isDone(.secret))
        viewModel.settings.sharedSecret = "own-secret"
        XCTAssertNil(viewModel.saveError)
        XCTAssertEqual(try store.load(patientID: "p1")?.sharedSecret, "own-secret")
    }

    func testTheServerOfAnotherPatientIsRefusedAndThePumpStepIsShown() async {
        let wrong = TrioRemoteSettingsViewModel(patientID: "p9", api: StubTrioAPI(response: target(team: "TEAM123456")), store: InMemoryTrioRemoteSettingsStore(), identity: identity)
        await wrong.refreshTarget()
        XCTAssertNil(wrong.target)
        XCTAssertEqual(wrong.targetError, "Serwer podał Trio innego pacjenta.")

        let withStep = TrioRemoteSettingsViewModel(patientID: "p1", api: StubTrioAPI(response: TrioRemoteTargetResponse(patient_id: "p1", trio: target(team: "TEAM123456").trio, pump_bolus_step: 0.1)), store: InMemoryTrioRemoteSettingsStore(), identity: identity)
        await withStep.refreshTarget()
        XCTAssertEqual(withStep.pumpBolusStep, Decimal(string: "0.1"))
        XCTAssertEqual(withStep.steps, [.trio, .secret, .key, .limits])
        XCTAssertEqual(withStep.doneCount, 1, "Trio remembered; the limits wait until they were opened")
        XCTAssertFalse(withStep.isDone(.limits))
        withStep.markLimitsReviewed()
        XCTAssertTrue(withStep.isDone(.limits))
    }
}

private let settingsTestP8 = """
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5kpsG6l2lB3pXegW
TOEyzMynfZFbKhNZTvtLTc6ncRqhRANCAATSjMU+b9Vk63O+VHbF24kH2SHnToGl
e+wzF+Enyzzw2H9lpubtBRWyT0oYcYym3TOR4XxAKiz2ZGjOnS2Sv+gi
-----END PRIVATE KEY-----
"""

extension TrioRemoteSettingsViewModelTests {
    func testNoWayToGiveABolusUntilEveryStepIsDone() {
        let trio = PinnedTrio(tokenHash: PinnedTrio.hash("ab"), bundleID: "org.nightscout.TEAM123456.trio", teamID: "TEAM123456", pinnedAt: Date())
        var settings = TrioRemoteSettings(sharedSecret: "secret", apnsKeyID: "KEY1234567", apnsKeyP8: settingsTestP8)
        XCTAssertFalse(settings.isComplete(glucoMindTeamID: "TEAM123456"), "Trio not remembered yet")
        settings.pinnedTrio = trio
        XCTAssertFalse(settings.isComplete(glucoMindTeamID: "TEAM123456"), "limits never opened")
        settings.limitsReviewed = true
        XCTAssertTrue(settings.isComplete(glucoMindTeamID: "TEAM123456"))
        // Trio built by another Apple team: the key for Trio's answer is a step too.
        XCTAssertFalse(settings.isComplete(glucoMindTeamID: "ZZZZZ99999"))
        settings.returnKeyID = "RET1234567"
        settings.returnKeyP8 = settingsTestP8
        XCTAssertTrue(settings.isComplete(glucoMindTeamID: "ZZZZZ99999"))
        settings.sharedSecret = " "
        XCTAssertFalse(settings.isComplete(glucoMindTeamID: "TEAM123456"))

        let store = InMemoryTrioRemoteSettingsStore()
        XCTAssertFalse(TrioRemoteSettings.isComplete(patientID: "p1", store: store, glucoMindTeamID: "TEAM123456"), "nothing on this phone")
    }
}

private struct StubTrioAPI: TrioRemoteTargetAPI {
    let response: TrioRemoteTargetResponse?

    func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse {
        guard let response else { throw URLError(.badServerResponse) }
        return response
    }
}
