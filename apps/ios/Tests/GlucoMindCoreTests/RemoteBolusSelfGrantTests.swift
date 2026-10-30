import XCTest
@testable import GlucoMindCore

/// Zdalny bolus for a freshly paired owner: the grant is turned on here ("Włącz zdalny bolus dla siebie") and confirmed
/// with Face ID in one flow; members keep the owner's explanation; the "Pętla i ten telefon" footer reads as sentences.
final class RemoteBolusSettingsTextTests: XCTestCase {
    func testOwnerWithoutGrantGetsTheButton() {
        XCTAssertEqual(RemoteBolusSettingsText.personAction(isOwner: true, state: .off, phoneReady: false, biometrics: true), .enableForSelf)
        XCTAssertEqual(RemoteBolusSettingsText.enableForSelfButton, "Włącz zdalny bolus dla siebie")
        let footer = RemoteBolusSettingsText.personFooter(isOwner: true, state: .off, phoneReady: false, biometrics: true)
        XCTAssertTrue(footer.hasPrefix("Jako właściciel włączasz go sobie tutaj. Po potwierdzeniu Face ID ten telefon utworzy swój klucz do bolusa."))
        XCTAssertTrue(footer.contains(DIYAcknowledgement.confirmingAccepts))
        XCTAssertFalse(footer.contains("Osoby i udostępnianie"))
    }

    func testOwnerWithoutFaceIDGetsNoButton() {
        XCTAssertEqual(RemoteBolusSettingsText.personAction(isOwner: true, state: .off, phoneReady: false, biometrics: false), .none)
        XCTAssertEqual(RemoteBolusSettingsText.personFooter(isOwner: true, state: .off, phoneReady: false, biometrics: false), DeviceBiometrics.unavailableMessage)
    }

    func testMemberKeepsTheExplanationReworded() {
        XCTAssertEqual(RemoteBolusSettingsText.personAction(isOwner: false, state: .off, phoneReady: false, biometrics: true), .none)
        XCTAssertEqual(
            RemoteBolusSettingsText.personFooter(isOwner: false, state: .off, phoneReady: false, biometrics: true),
            "Zdalny bolus włącza Ci właściciel (Osoby i udostępnianie). Potem potwierdzisz go tu Face ID."
        )
    }

    func testAwaitingGrantShowsTheConfirmation() {
        XCTAssertEqual(RemoteBolusSettingsText.personAction(isOwner: true, state: .awaitingConfirmation, phoneReady: false, biometrics: true), .confirm)
        XCTAssertEqual(RemoteBolusSettingsText.personAction(isOwner: false, state: .awaitingConfirmation, phoneReady: false, biometrics: true), .confirm)
        XCTAssertTrue(RemoteBolusSettingsText.personFooter(isOwner: true, state: .awaitingConfirmation, phoneReady: false, biometrics: true).hasPrefix("Zdalny bolus jest dla Ciebie włączony, ale czeka na potwierdzenie. Potwierdź go Face ID"))
        XCTAssertTrue(RemoteBolusSettingsText.personFooter(isOwner: false, state: .awaitingConfirmation, phoneReady: false, biometrics: true).hasPrefix("Właściciel włączył Ci zdalny bolus. Potwierdź go Face ID"))
        XCTAssertEqual(RemoteBolusSettingsText.personAction(isOwner: true, state: .on, phoneReady: false, biometrics: true), .setUpThisPhone)
        XCTAssertEqual(RemoteBolusSettingsText.personAction(isOwner: true, state: .on, phoneReady: true, biometrics: true), .none)
    }

    func testLoopFooterPerReason() {
        let notPermitted = RemoteCommandsAccess(enabled: false, reason: "CAREGIVER_NOT_PERMITTED")
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: notPermitted, isOwner: true, grant: .off), "Najpierw włącz zdalny bolus dla siebie (wyżej).")
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: notPermitted, isOwner: false, grant: .off), "Właściciel nie włączył Ci zdalnych poleceń dla tego pacjenta.")
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: notPermitted, isOwner: true, grant: .awaitingConfirmation), "Najpierw potwierdź zdalny bolus Face ID (wyżej).")
        // Unknown person (people not read, or outside device mode): the server's reason alone.
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: notPermitted, isOwner: nil, grant: nil), "Twoje konto nie ma uprawnienia do zdalnych poleceń dla tego pacjenta.")
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: RemoteCommandsAccess(enabled: false, reason: "SERVER_DISABLED"), isOwner: true, grant: .off), "Wyłączone na serwerze.")
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: RemoteCommandsAccess(enabled: false, reason: "PATIENT_DISABLED"), isOwner: true, grant: .off), "Wyłączone dla tego pacjenta.")
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: RemoteCommandsAccess(enabled: false, reason: "LOOP_SYSTEM_NOT_SUPPORTED"), isOwner: nil, grant: nil), "Pętla tego pacjenta nie przyjmuje jeszcze poleceń z aplikacji Mellis (na razie tylko Trio).")
        XCTAssertEqual(RemoteBolusSettingsText.loopFooter(remoteCommands: .off, isOwner: true, grant: .off), "Nie udało się sprawdzić uprawnień.")
        XCTAssertTrue(RemoteBolusSettingsText.loopFooter(remoteCommands: RemoteCommandsAccess(enabled: true, reason: "ENABLED", driver: "TRIO"), isOwner: true, grant: .on).hasPrefix("Na tym telefonie. Polecenia do Trio wysyła ten telefon."))
        XCTAssertTrue(RemoteBolusSettingsText.loopFooter(remoteCommands: RemoteCommandsAccess(enabled: true, reason: "ENABLED", driver: "LOOP"), isOwner: true, grant: .on).hasPrefix("Na tym telefonie. Polecenia do Loopa wysyła ten telefon."))
    }

    func testNoOffFooterEndsWithTheAppendedPhoneSentence() {
        for reason in ["SERVER_DISABLED", "LOOP_SYSTEM_NOT_SUPPORTED", "PATIENT_DISABLED", "CAREGIVER_NOT_PERMITTED", "UNKNOWN"] {
            for (isOwner, grant) in [(Bool?.none, RemoteBolusGrantState?.none), (true, .off), (false, .off), (true, .awaitingConfirmation)] {
                let footer = RemoteBolusSettingsText.loopFooter(remoteCommands: RemoteCommandsAccess(enabled: false, reason: reason), isOwner: isOwner, grant: grant)
                XCTAssertFalse(footer.contains(SettingsText.onThisPhone), "\(reason): \(footer)")
                XCTAssertTrue(footer.hasSuffix("."), footer)
            }
        }
    }
}

@MainActor
final class RemoteBolusSelfGrantTests: XCTestCase {
    private func signer() throws -> DeviceRemoteCommandSigner {
        let keys = InMemoryDeviceKeyStore()
        _ = try keys.createKeys()
        _ = try keys.createBolusKey()
        return DeviceRemoteCommandSigner(api: FakeSigningAPI(now: Date()), deviceID: { "d1" }, keys: keys)
    }

    func testOwnerGrantsThemselfThenConfirmsInOneFlow() async throws {
        let api = SelfGrantSharingAPI(owner: true)
        let store = InMemoryDIYAcknowledgementStore()
        let model = DeviceSharingViewModel(patientID: "p1", patientName: "Zosia", api: api, signer: try signer(), acknowledgement: store)
        await model.load()
        XCTAssertEqual(model.people?.you?.remote_bolus.state, .off)
        let enabled = await model.enableRemoteBolusForSelf()
        XCTAssertTrue(enabled)
        XCTAssertEqual(api.calls, ["list", "update u-me [\"remote_commands\": true]", "list", "confirm", "list"])
        XCTAssertNotNil(api.confirmation)
        XCTAssertNotNil(store.acceptedAt(.remoteBolus))
        XCTAssertEqual(model.people?.you?.remote_bolus.state, .on)
        XCTAssertNil(model.errorMessage)
    }

    func testAWaitingGrantIsOnlyConfirmed() async throws {
        let api = SelfGrantSharingAPI(owner: true, state: .awaitingConfirmation)
        let model = DeviceSharingViewModel(patientID: "p1", patientName: "Zosia", api: api, signer: try signer())
        await model.load()
        let enabled = await model.enableRemoteBolusForSelf()
        XCTAssertTrue(enabled)
        XCTAssertEqual(api.calls, ["list", "confirm", "list"])
    }

    func testNothingIsGrantedWithoutASignerOrForAMember() async throws {
        let owner = SelfGrantSharingAPI(owner: true)
        let unsigned = DeviceSharingViewModel(patientID: "p1", patientName: "Zosia", api: owner, signer: nil)
        await unsigned.load()
        let unsignedEnabled = await unsigned.enableRemoteBolusForSelf()
        XCTAssertFalse(unsignedEnabled)
        XCTAssertEqual(owner.calls, ["list"])

        let member = SelfGrantSharingAPI(owner: false)
        let model = DeviceSharingViewModel(patientID: "p1", patientName: "Zosia", api: member, signer: try signer())
        await model.load()
        let memberEnabled = await model.enableRemoteBolusForSelf()
        XCTAssertFalse(memberEnabled)
        XCTAssertEqual(member.calls, ["list"])
    }

    func testCancelledFaceIDLeavesTheGrantWaiting() async throws {
        let api = SelfGrantSharingAPI(owner: true)
        let model = DeviceSharingViewModel(patientID: "p1", patientName: "Zosia", api: api, signer: CancellingSigner())
        await model.load()
        let enabled = await model.enableRemoteBolusForSelf()
        XCTAssertFalse(enabled)
        XCTAssertEqual(model.people?.you?.remote_bolus.state, .awaitingConfirmation)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(api.calls.contains("confirm"))
    }
}

private final class CancellingSigner: RemoteCommandSigning {
    func prepare(patientID: String) async {}
    func signRemoteCommand(patientID: String, insulinU: Decimal, carbsG: Int) async throws -> SignedRemoteCommand {
        throw RemoteCommandSigningError.key(.cancelled)
    }
    func signRemoteBolusConfirm(patientID: String, diyAcknowledgedAt: Date?) async throws -> SignedRemoteCommand {
        throw RemoteCommandSigningError.key(.cancelled)
    }
}

/// One person ("u-me", is_you) whose grant follows the calls, as the server keeps it.
final class SelfGrantSharingAPI: DeviceSharingAPI, @unchecked Sendable {
    private let owner: Bool
    private var state: RemoteBolusGrantState
    private(set) var calls: [String] = []
    private(set) var confirmation: DeviceAuthorizationEnvelope?

    init(owner: Bool, state: RemoteBolusGrantState = .off) {
        self.owner = owner
        self.state = state
    }

    private var you: PatientPerson {
        let grant: RemoteBolusGrant
        switch state {
        case .off: grant = RemoteBolusGrant()
        case .awaitingConfirmation: grant = RemoteBolusGrant(granted_by: "u-me", granted_at: "2026-10-30T08:00:00Z")
        case .on: grant = RemoteBolusGrant(granted_by: "u-me", granted_at: "2026-10-30T08:00:00Z", confirmed_at: "2026-10-30T08:00:10Z", effective: true)
        }
        return PatientPerson(user_id: "u-me", display_name: "Tomek", is_owner: owner, permissions: SharingPermissions(manage_sharing: owner, remote_commands: state == .on), remote_bolus: grant, is_you: true, devices: [])
    }

    func listPeople(patientID: String) async throws -> PatientPeopleResponse {
        calls.append("list")
        return PatientPeopleResponse(patient_id: patientID, you_are_owner: owner, people: [you], invitations: [])
    }
    func updatePerson(patientID: String, userID: String, changes: [String: Bool]) async throws -> PatientPerson {
        calls.append("update \(userID) \(changes)")
        if changes["remote_commands"] == true, state == .off { state = .awaitingConfirmation }
        return you
    }
    func confirmRemoteBolus(patientID: String, authorization: DeviceAuthorizationEnvelope) async throws -> PatientPerson {
        calls.append("confirm")
        confirmation = authorization
        state = .on
        return you
    }

    func listOwnDevices() async throws -> [PairedDevice] { [] }
    func revokeOwnDevice(deviceID: String) async throws {}
    func createOwnPairingCode() async throws -> PairingCode { PairingCode(code: "c", expires_at: "", pairing_url: "mellis://pair") }
    func acceptInvitation(code: String) async throws -> InvitationAcceptResponse { InvitationAcceptResponse(patient_id: "p2", member: nil) }
    func createInvitation(patientID: String, firstName: String, permissions: SharingPermissions) async throws -> InvitationCreateResponse { throw APIClientError.invalidResponse }
    func revokeInvitation(patientID: String, invitationID: String) async throws {}
    func removePerson(patientID: String, userID: String) async throws {}
    func revokeMemberDevice(patientID: String, userID: String, deviceID: String) async throws {}
    func createPatient(_ body: NewPatientBody) async throws -> NewPatientResponse { throw APIClientError.invalidResponse }
    func listCoOwnerCandidates() async throws -> [CoOwnerCandidate] { [] }
    func nightscoutSummary(patientID: String) async throws -> NightscoutSummary { NightscoutSummary(patient_id: patientID, base_url: "https://zosia.ns.example", last_reading_at: nil) }
}
