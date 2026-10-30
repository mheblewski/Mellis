import CryptoKit
import XCTest
@testable import GlucoMindCore

/// "Jeszcze jeden krok" (1.0.5): what is missing after the settings are saved, the texts, the once-per-save stamp, and
/// the hand-off push the app reacts to.
final class RemoteBolusNextStepTests: XCTestCase {
    private let patientID = "11111111-1111-4111-8111-111111111111"
    private let team = "ABCDE12345"

    func testWhatIsMissing() {
        XCTAssertEqual(RemoteBolusNextStep.decide(isOwner: true, state: .off, phoneReady: false, biometrics: true), .enableForSelf)
        XCTAssertEqual(RemoteBolusNextStep.decide(isOwner: true, state: .awaitingConfirmation, phoneReady: false, biometrics: true), .confirm)
        XCTAssertEqual(RemoteBolusNextStep.decide(isOwner: false, state: .awaitingConfirmation, phoneReady: false, biometrics: true), .confirm)
        XCTAssertEqual(RemoteBolusNextStep.decide(isOwner: false, state: .off, phoneReady: false, biometrics: true), .askOwner)
        XCTAssertEqual(RemoteBolusNextStep.decide(isOwner: false, state: .on, phoneReady: false, biometrics: true), .setUpThisPhone)
        XCTAssertNil(RemoteBolusNextStep.decide(isOwner: true, state: .on, phoneReady: true, biometrics: true))
        // Without Face ID / Touch ID nothing can be started here (Settings explains it); the owner still has to act.
        XCTAssertNil(RemoteBolusNextStep.decide(isOwner: true, state: .off, phoneReady: false, biometrics: false))
        XCTAssertNil(RemoteBolusNextStep.decide(isOwner: false, state: .awaitingConfirmation, phoneReady: false, biometrics: false))
        XCTAssertEqual(RemoteBolusNextStep.decide(isOwner: false, state: .off, phoneReady: false, biometrics: false), .askOwner)
    }

    func testTexts() {
        XCTAssertEqual(RemoteBolusNextStep.title, "Jeszcze jeden krok")
        XCTAssertEqual(RemoteBolusNextStep.confirm.message(loopName: "Trio", patientName: "Zosia"),
                       "Ustawienia Trio dla: Zosia są zapisane na tym telefonie. Żeby wysyłać bolusy, potwierdź zdalny bolus Face ID.")
        XCTAssertEqual(RemoteBolusNextStep.enableForSelf.message(loopName: "Loop", patientName: "Zosia"),
                       "Ustawienia Loop dla: Zosia są zapisane na tym telefonie. Żeby wysyłać bolusy, potwierdź zdalny bolus Face ID.")
        XCTAssertEqual(RemoteBolusNextStep.askOwner.message(loopName: "Trio", patientName: "Zosia"),
                       "Ustawienia Trio dla: Zosia są zapisane na tym telefonie. Właściciel musi jeszcze włączyć Ci zdalny bolus (Osoby i udostępnianie).")
        XCTAssertFalse(RemoteBolusNextStep.askOwner.canActHere)
        XCTAssertTrue(RemoteBolusNextStep.confirm.canActHere)
    }

    private func completeTrio(pinnedAt: Date) -> TrioRemoteSettings {
        var settings = TrioRemoteSettings(
            sharedSecret: "fikcyjny-sekret", apnsKeyID: "KEYID12345", apnsKeyP8: P256.Signing.PrivateKey().pemRepresentation,
            pinnedTrio: PinnedTrio(tokenHash: PinnedTrio.hash("trio-token"), bundleID: "org.nightscout.\(team).trio", teamID: team, pinnedAt: pinnedAt)
        )
        settings.limitsReviewed = true
        return settings
    }

    func testOneStampPerSettingsSave() throws {
        let first = try XCTUnwrap(RemoteBolusNextStep.settingsStamp(patientID: patientID, trio: completeTrio(pinnedAt: Date(timeIntervalSince1970: 1_000)), loop: nil, glucoMindTeamID: team, prefersLoop: false))
        XCTAssertEqual(first.loopName, "Trio")
        var edited = completeTrio(pinnedAt: Date(timeIntervalSince1970: 1_000))
        edited.maxBolusUnits = 3
        // Limits changed later: the same save, no new sheet.
        XCTAssertEqual(RemoteBolusNextStep.settingsStamp(patientID: patientID, trio: edited, loop: nil, glucoMindTeamID: team, prefersLoop: false)?.stamp, first.stamp)
        // A new hand-off saved (its Trio pinned again): a new stamp.
        XCTAssertNotEqual(RemoteBolusNextStep.settingsStamp(patientID: patientID, trio: completeTrio(pinnedAt: Date(timeIntervalSince1970: 2_000)), loop: nil, glucoMindTeamID: team, prefersLoop: false)?.stamp, first.stamp)
        // Incomplete settings: nothing is ready, nothing to say.
        var incomplete = completeTrio(pinnedAt: Date())
        incomplete.limitsReviewed = false
        XCTAssertNil(RemoteBolusNextStep.settingsStamp(patientID: patientID, trio: incomplete, loop: nil, glucoMindTeamID: team, prefersLoop: false))
        XCTAssertNil(RemoteBolusNextStep.settingsStamp(patientID: patientID, trio: nil, loop: nil, glucoMindTeamID: team, prefersLoop: false))
    }

    func testThePromptStoreRemembersShownStamps() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "RemoteBolusNextStepTests"))
        defaults.removePersistentDomain(forName: "RemoteBolusNextStepTests")
        let store = UserDefaultsRemoteBolusNextStepPromptStore(defaults: defaults)
        XCTAssertFalse(store.wasShown("trio:a:1"))
        store.markShown("trio:a:1")
        XCTAssertTrue(UserDefaultsRemoteBolusNextStepPromptStore(defaults: defaults).wasShown("trio:a:1"))
        XCTAssertFalse(store.wasShown("trio:a:2"))
        defaults.removePersistentDomain(forName: "RemoteBolusNextStepTests")
    }

    func testTheHandoffPushIsRecognised() throws {
        let handoffID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
        let payload: [AnyHashable: Any] = ["gluco": ["type": "remote_settings_handoff", "patientId": patientID, "handoffId": handoffID, "routePath": "/patients/\(patientID)"]]
        let parsed = try XCTUnwrap(PushPayloadParser.remoteSettingsHandoff(userInfo: payload))
        XCTAssertEqual(parsed.patientID, patientID)
        XCTAssertEqual(parsed.handoffID, handoffID.lowercased())
        // A tap opens the patient (their screen offers the package).
        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .patient(patientID: patientID))
        XCTAssertNil(PushPayloadParser.remoteSettingsHandoff(userInfo: ["gluco": ["type": "care_reminder", "patientId": patientID]]))
    }
}
