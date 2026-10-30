import XCTest
@testable import GlucoMindCore

private final class MemorySeenStore: SetupGuideSeenStoring {
    var seen: Set<String> = []
    var pending: Set<String> = []
    func hasSeen(_ key: String) -> Bool { seen.contains(key) }
    func markSeen(_ key: String) { seen.insert(key) }
    func isPending(_ key: String) -> Bool { pending.contains(key) }
    func setPending(_ key: String, _ value: Bool) { if value { pending.insert(key) } else { pending.remove(key) } }
}

@MainActor
final class SetupGuideTests: XCTestCase {
    private let enabled = RemoteCommandsAccess(enabled: true, reason: "ENABLED", driver: "TRIO")
    private let notPermitted = RemoteCommandsAccess(enabled: false, reason: "CAREGIVER_NOT_PERMITTED")

    // MARK: Steps per role

    func testOwnerGetsEveryStep() {
        let access = SetupGuideAccess(remoteControl: true, loopSystem: .trio)
        XCTAssertEqual(access.steps, [.remoteControl, .notifications, .instructions, .done])
    }

    func testCaregiverWithoutRemoteBolusSkipsTheRemoteStep() {
        let access = SetupGuideAccess(remoteControl: false)
        XCTAssertEqual(access.steps, [.notifications, .instructions, .done])
    }

    func testGlucoseOnlyObserverGetsNotificationsOnly() {
        let access = SetupGuideAccess(remoteControl: false, glucoseAlerts: true, assistant: false)
        XCTAssertEqual(access.steps, [.notifications, .done])
    }

    func testServerWithoutInstructionsLeavesThatStepOut() {
        let access = SetupGuideAccess(remoteControl: true, hasAiPreferences: false)
        XCTAssertEqual(access.steps, [.remoteControl, .notifications, .done])
    }

    func testRemoteStepRules() {
        // An owner may grant it to themself, even before the grant.
        XCTAssertTrue(SetupGuideAccess.allowsRemoteControl(deviceMode: true, isOwner: true, grant: .off, remoteCommands: notPermitted, setUpOnThisPhone: false))
        // A caregiver only once an owner granted it (confirmed or still to confirm with Face ID).
        XCTAssertFalse(SetupGuideAccess.allowsRemoteControl(deviceMode: true, isOwner: false, grant: .off, remoteCommands: notPermitted, setUpOnThisPhone: false))
        XCTAssertTrue(SetupGuideAccess.allowsRemoteControl(deviceMode: true, isOwner: false, grant: .awaitingConfirmation, remoteCommands: notPermitted, setUpOnThisPhone: false))
        XCTAssertTrue(SetupGuideAccess.allowsRemoteControl(deviceMode: true, isOwner: false, grant: .on, remoteCommands: enabled, setUpOnThisPhone: false))
        // Unknown people (a read that failed): not shown.
        XCTAssertFalse(SetupGuideAccess.allowsRemoteControl(deviceMode: true, isOwner: nil, grant: nil, remoteCommands: enabled, setUpOnThisPhone: false))
        // Off on the server, for the patient, or a loop without commands: nothing to set up, even for an owner.
        for reason in ["SERVER_DISABLED", "PATIENT_DISABLED", "LOOP_SYSTEM_NOT_SUPPORTED", "UNKNOWN"] {
            XCTAssertFalse(SetupGuideAccess.allowsRemoteControl(deviceMode: true, isOwner: true, grant: .on, remoteCommands: RemoteCommandsAccess(enabled: false, reason: reason), setUpOnThisPhone: false), reason)
        }
        // Already complete on this phone.
        XCTAssertFalse(SetupGuideAccess.allowsRemoteControl(deviceMode: true, isOwner: true, grant: .on, remoteCommands: enabled, setUpOnThisPhone: true))
        // The account build: the server's answer alone.
        XCTAssertTrue(SetupGuideAccess.allowsRemoteControl(deviceMode: false, isOwner: nil, grant: nil, remoteCommands: enabled, setUpOnThisPhone: false))
        XCTAssertFalse(SetupGuideAccess.allowsRemoteControl(deviceMode: false, isOwner: nil, grant: nil, remoteCommands: notPermitted, setUpOnThisPhone: false))
    }

    // MARK: Moving through

    func testProgressCountsTheStepsAndBackStopsAtTheFirst() {
        let model = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: true), patientName: "Zosia", store: MemorySeenStore(), key: "k")
        XCTAssertEqual(model.current, .remoteControl)
        XCTAssertEqual(model.progressText, "1/3")
        XCTAssertFalse(model.canGoBack)
        model.next()
        XCTAssertEqual(model.current, .notifications)
        XCTAssertEqual(model.progressText, "2/3")
        XCTAssertTrue(model.canGoBack)
        model.back()
        XCTAssertEqual(model.current, .remoteControl)
        model.back()
        XCTAssertEqual(model.current, .remoteControl)
        model.next(); model.next(); model.next()
        XCTAssertEqual(model.current, .done)
        XCTAssertNil(model.progressText)
        XCTAssertFalse(model.isClosed)
        model.next()
        XCTAssertTrue(model.isClosed)
    }

    func testObserverProgressIsOneStep() {
        let model = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: false, assistant: false), patientName: "Zosia", store: MemorySeenStore(), key: "k")
        XCTAssertEqual(model.progressText, "1/1")
    }

    func testSkipShowsWhereToChangeItLaterAndCountsAsSeen() {
        let store = MemorySeenStore()
        let model = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: true), patientName: "Zosia", store: store, key: "k")
        model.postpone()
        XCTAssertTrue(model.isPostponed(.remoteControl))
        XCTAssertEqual(model.current, .remoteControl, "the note shows on the same page")
        XCTAssertTrue(store.hasSeen("k"))
        XCTAssertEqual(SetupGuideText.laterNote(.remoteControl, patientName: "Zosia"), "Możesz to zrobić później w Ustawieniach → Zosia → Zdalny bolus.")
        XCTAssertEqual(SetupGuideText.laterNote(.notifications, patientName: "Zosia"), "Możesz to zmienić później w Ustawieniach → Zosia → Powiadomienia: Zosia.")
        XCTAssertEqual(SetupGuideText.laterNote(.instructions, patientName: "Zosia"), "Możesz je wpisać później w Ustawieniach → Instrukcje dla Mellis.")
        // Opening the settings after all clears the note.
        model.didOpen(.remoteControl)
        XCTAssertFalse(model.isPostponed(.remoteControl))
        XCTAssertTrue(model.wasOpened(.remoteControl))
    }

    func testStartsAtTheAskedStepOrTheFirstWhenItIsNotForThisPerson() {
        let owner = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: true), patientName: "Zosia", store: MemorySeenStore(), key: nil, startAt: .instructions)
        XCTAssertEqual(owner.current, .instructions)
        let observer = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: false, assistant: false), patientName: "Zosia", store: MemorySeenStore(), key: nil, startAt: .remoteControl)
        XCTAssertEqual(observer.current, .notifications)
    }

    // MARK: Persistence

    func testShownOncePerServerAndPersonOnThisPhone() {
        let defaults = UserDefaults(suiteName: "SetupGuideTests-\(UUID().uuidString)")!
        let store = UserDefaultsSetupGuideSeenStore(defaults: defaults)
        let server = URL(string: "https://mellis.example")!
        let key = SetupGuideKey.make(server: server, userID: "U-1")
        XCTAssertEqual(key, "mellis.example|u-1")
        SetupGuideViewModel.noteNewPairing(store: store, key: key)
        XCTAssertTrue(SetupGuideViewModel.shouldOffer(store: store, key: key))

        let model = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: false), patientName: "Zosia", store: store, key: key)
        model.markShown()
        XCTAssertFalse(SetupGuideViewModel.shouldOffer(store: store, key: key))
        // Another person, or the same person on another server, still gets it after pairing this phone with them.
        for other in [SetupGuideKey.make(server: server, userID: "u-2"), SetupGuideKey.make(server: URL(string: "https://mellis.example:8443")!, userID: "u-1")] {
            XCTAssertFalse(SetupGuideViewModel.shouldOffer(store: store, key: other), "not before a pairing")
            SetupGuideViewModel.noteNewPairing(store: store, key: other)
            XCTAssertTrue(SetupGuideViewModel.shouldOffer(store: store, key: other))
        }
        // A new store over the same defaults (next launch) remembers it.
        XCTAssertFalse(SetupGuideViewModel.shouldOffer(store: UserDefaultsSetupGuideSeenStore(defaults: defaults), key: key))
    }

    func testAnExistingSessionAfterAnUpdateDoesNotShowTheGuide() {
        // Updated from 1.0.1: signed in / paired long ago, no marks at all (the guide did not exist then).
        let defaults = UserDefaults(suiteName: "SetupGuideTests-\(UUID().uuidString)")!
        let key = SetupGuideKey.make(server: URL(string: "https://mellis.example")!, userID: "u-1")
        XCTAssertFalse(SetupGuideViewModel.shouldOffer(store: UserDefaultsSetupGuideSeenStore(defaults: defaults), key: key))
        // Next launches too: only a pairing / sign-in sets the mark.
        XCTAssertFalse(SetupGuideViewModel.shouldOffer(store: UserDefaultsSetupGuideSeenStore(defaults: defaults), key: key))
    }

    func testAFreshPairingShowsTheGuideOnce() {
        let defaults = UserDefaults(suiteName: "SetupGuideTests-\(UUID().uuidString)")!
        let store = UserDefaultsSetupGuideSeenStore(defaults: defaults)
        let key = SetupGuideKey.make(server: URL(string: "https://mellis.example")!, userID: "u-1")
        SetupGuideViewModel.noteNewPairing(store: store, key: key)
        // Still pending at the next launch (the app was closed before the dashboard).
        XCTAssertTrue(SetupGuideViewModel.shouldOffer(store: UserDefaultsSetupGuideSeenStore(defaults: defaults), key: key))

        let model = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: true), patientName: "Zosia", store: store, key: key)
        model.markShown()
        XCTAssertFalse(store.isPending(key), "shown: the pending mark goes")
        XCTAssertFalse(SetupGuideViewModel.shouldOffer(store: store, key: key))
        // Unpaired and paired again with the same person: already seen here, not again.
        SetupGuideViewModel.noteNewPairing(store: store, key: key)
        XCTAssertFalse(SetupGuideViewModel.shouldOffer(store: store, key: key))
        SetupGuideViewModel.clearPending(store: store, key: key)
        XCTAssertFalse(store.isPending(key))
    }

    func testClosingMarksSeenAndAReopenedGuideChangesNoMark() {
        let store = MemorySeenStore()
        let model = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: true), patientName: "Zosia", store: store, key: "k")
        model.close()
        XCTAssertTrue(model.isClosed)
        XCTAssertTrue(store.hasSeen("k"))
        XCTAssertFalse(model.canGoBack)

        let reopened = SetupGuideViewModel(access: SetupGuideAccess(remoteControl: true), patientName: "Zosia", store: store, key: nil)
        reopened.markShown()
        reopened.close()
        XCTAssertEqual(store.seen, ["k"])
    }

    // MARK: Texts

    func testRemoteTitleNamesTheLoop() {
        XCTAssertEqual(SetupGuideText.remoteTitle(.trio), "Zdalne podawanie insuliny w Trio")
        XCTAssertEqual(SetupGuideText.remoteTitle(.loop), "Zdalne podawanie insuliny w Loopie")
        XCTAssertEqual(SetupGuideText.remoteTitle(.unknown), "Zdalne podawanie insuliny w Trio / Loop")
        XCTAssertEqual(SetupGuideText.remoteTitle(.aaps), "Zdalne podawanie insuliny w Trio / Loop")
        XCTAssertTrue(SetupGuideText.remoteDetail(.loop, patientName: "Zosia").contains("do Loopa"))
        // Never a declined "Mellis" in the guide.
        let texts = [SetupGuideText.notificationsDetail, SetupGuideText.instructionsTitle, SetupGuideText.instructionsDetail, SetupGuideText.doneDetail]
            + SetupGuideStep.allCases.compactMap { SetupGuideText.laterNote($0, patientName: "Zosia") }
        for text in texts {
            XCTAssertNil(text.range(of: #"Mellis(a|ie|em|owi)\b"#, options: .regularExpression), text)
        }
    }
}
