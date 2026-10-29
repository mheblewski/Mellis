import XCTest
@testable import GlucoMindCore

/// The transport is a recorder: no test sends anything to APNs or Trio.
@MainActor
final class RemoteCommandSenderTests: XCTestCase {
    private let testP8 = """
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5kpsG6l2lB3pXegW
TOEyzMynfZFbKhNZTvtLTc6ncRqhRANCAATSjMU+b9Vk63O+VHbF24kH2SHnToGl
e+wzF+Enyzzw2H9lpubtBRWyT0oYcYym3TOR4XxAKiz2ZGjOnS2Sv+gi
-----END PRIVATE KEY-----
"""
    private let now = ISO8601DateFormatter().date(from: "2026-10-19T12:00:00Z")!
    private let identity = GlucoMindPushIdentity(bundleID: "pl.glucomind.ios", teamID: "TEAM123456", productionEnvironment: false)

    /// The fake Nightscout's Trio, as the caregiver confirmed it.
    private var pinnedTrio: PinnedTrio {
        PinnedTrio(tokenHash: PinnedTrio.hash(String(repeating: "ab", count: 32)), bundleID: "org.nightscout.TEAM123456.trio", teamID: "TEAM123456", pinnedAt: now)
    }

    private func makeSender(api: FakeRemoteAPI, transport: RecordingTransport, biometrics: BiometricResult = .confirmed, settings: TrioRemoteSettings? = nil, pending: MemoryPendingStore = MemoryPendingStore(), notifier: RecordingNotifier = RecordingNotifier(), token: String? = "cafe", store: InMemoryTrioRemoteSettingsStore = InMemoryTrioRemoteSettingsStore(), pinned: Bool = true, patientName: String? = nil) -> RemoteCommandSender {
        var stored = settings ?? TrioRemoteSettings(sharedSecret: "trio-secret", apnsKeyID: "KEY1234567", apnsKeyP8: testP8, maxBolusUnits: 10, maxCarbsGrams: 120)
        if pinned && stored.pinnedTrio == nil { stored.pinnedTrio = pinnedTrio }
        try? store.save(stored, patientID: "p1")
        return RemoteCommandSender(patientID: "p1", api: api, settingsStore: store, transport: transport, biometrics: FixedBiometrics(result: biometrics), identity: identity, deviceID: "device-1", pushToken: { token }, pendingStore: pending, notifier: notifier, patientName: patientName, now: { self.now })
    }

    func testNothingGoesToATrioNotConfirmedForThisPatient() async {
        let transport = RecordingTransport(status: 200)
        // Settings saved before Trio was remembered: the first send remembers it and goes.
        let store = InMemoryTrioRemoteSettingsStore()
        let unconfirmed = FakeRemoteAPI(now: now)
        let firstSend = RecordingTransport(status: 200)
        let first = await makeSender(api: unconfirmed, transport: firstSend, store: store, pinned: false, patientName: "Franciszek").send(draft)
        guard case .sent = first else { return XCTFail("\(first)") }
        XCTAssertEqual(try store.load(patientID: "p1")?.pinnedTrio, pinnedTrio.withDate(now))
        // Nightscout now shows another phone's Trio.
        var moved = TrioRemoteSettings(sharedSecret: "trio-secret", apnsKeyID: "KEY1234567", apnsKeyP8: testP8, maxBolusUnits: 10, maxCarbsGrams: 120)
        moved.pinnedTrio = PinnedTrio(tokenHash: PinnedTrio.hash("old-phone"), bundleID: "org.nightscout.TEAM123456.trio", teamID: "TEAM123456", pinnedAt: now)
        let second = await makeSender(api: FakeRemoteAPI(now: now), transport: transport, settings: moved).send(draft)
        XCTAssertEqual(second, .notSent("Nightscout tego pacjenta pokazuje inne Trio niż przy konfiguracji (nowa instalacja Trio, nowy telefon albo inny Nightscout). Potwierdź je w ustawieniach zdalnego sterowania."))
        // The same Trio is another patient's on this phone.
        let shared = InMemoryTrioRemoteSettingsStore()
        try? shared.save(TrioRemoteSettings(sharedSecret: "other-secret", apnsKeyID: "KEY1234567", apnsKeyP8: testP8, pinnedTrio: pinnedTrio), patientID: "p2")
        let third = await makeSender(api: FakeRemoteAPI(now: now), transport: transport, store: shared).send(draft)
        XCTAssertEqual(third, .notSent("To Trio jest na tym telefonie przypisane do innego pacjenta. Nic nie zostało wysłane."))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testNothingGoesWithAnotherPatientsSecretOrForAnotherPatient() async {
        let transport = RecordingTransport(status: 200)
        let store = InMemoryTrioRemoteSettingsStore()
        try? store.save(TrioRemoteSettings(sharedSecret: "trio-secret", apnsKeyID: "KEY1234567", apnsKeyP8: testP8), patientID: "p2")
        let sameSecret = await makeSender(api: FakeRemoteAPI(now: now), transport: transport, store: store).send(draft)
        XCTAssertEqual(sameSecret, .notSent(TrioPatientGuard.secretMessage))

        // The server records the command for someone else: reported as not sent, no push.
        let api = FakeRemoteAPI(now: now)
        api.commandPatientID = "p2"
        let wrong = await makeSender(api: api, transport: transport).send(draft)
        XCTAssertEqual(wrong, .notSent("Serwer zapisał polecenie dla innego pacjenta. Nic nie zostało wysłane."))
        XCTAssertEqual(api.sentReports.map(\.accepted), [false])
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testThePatientIsNamedInTheNotifications() async {
        let notifier = RecordingNotifier()
        _ = await makeSender(api: FakeRemoteAPI(now: now), transport: RecordingTransport(status: 200), notifier: notifier, patientName: "Franciszek").send(draft)
        XCTAssertEqual(notifier.summaries.first, "4,6 j insuliny i 46 g węglowodanów · Franciszek")
        let pending = PendingRemoteCommand(patientID: "p1", commandID: "c1", carbsG: 46, insulinU: Decimal(string: "4.6")!, sentAt: now, patientName: "Franciszek")
        XCTAssertEqual(TrioReplyHandler.resultNotification(success: true, text: "Bolus podany", pending: pending).title, "✅ Bolus podany · Franciszek")
    }

    private let draft = RemoteCommandDraft(source: .bolusScreen, carbsG: 46, insulinU: Decimal(string: "4.6")!, meal: RemoteCommandMeal(description: "Naleśniki", items: nil, macros: nil), acknowledgedWarnings: ["RECENT_BOLUS"])

    func testAChatCardSaysItsOwnWarningsWereShown() async throws {
        let api = FakeRemoteAPI(now: now)
        let card = RemoteCommandDraft(source: .chatCard, carbsG: 46, insulinU: Decimal(string: "4.6")!, conversationID: "c", proposalID: "card-1", acknowledgedWarnings: ["FORECAST_LOW:x"])
        _ = await makeSender(api: api, transport: RecordingTransport(status: 200)).send(card)
        XCTAssertEqual(api.authorized?.card_warnings_shown, true)
        XCTAssertEqual(api.authorized?.acknowledged_warnings, ["FORECAST_LOW:x"])
    }

    func testSendsOneEncryptedMealWithBolusAfterFaceIDAndTheServer() async throws {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 200)
        let pending = MemoryPendingStore()
        let notifier = RecordingNotifier()
        let outcome = await makeSender(api: api, transport: transport, pending: pending, notifier: notifier).send(draft)

        guard case let .sent(command) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(command.status, "SENT")
        XCTAssertEqual(api.authorized?.acknowledged_warnings, ["RECENT_BOLUS"])
        XCTAssertEqual(api.authorized?.bolus_step, Decimal(string: "0.05"))
        // Not a chat card: the server is not told its warnings were shown.
        XCTAssertNil(api.authorized?.card_warnings_shown)
        XCTAssertEqual(transport.requests.count, 1)
        let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: Any]
        let decrypted = try TrioSecureMessenger(sharedSecret: "trio-secret").decrypt(body["encrypted_data"] as! String)
        let json = try JSONSerialization.jsonObject(with: decrypted) as! [String: Any]
        XCTAssertEqual(json["command_type"] as? String, "meal")
        XCTAssertEqual(json["carbs"] as? Int, 46)
        XCTAssertEqual((json["bolus_amount"] as? NSNumber)?.decimalValue, Decimal(string: "4.6"))
        XCTAssertEqual(json["command_id"] as? String, "c1")
        let back = json["return_notification"] as! [String: Any]
        XCTAssertEqual(back["device_token"] as? String, "cafe")
        XCTAssertEqual(back["team_id"] as? String, "TEAM123456")
        XCTAssertEqual(back["production_environment"] as? Bool, false)
        XCTAssertEqual(pending.pending?.commandID, "c1")
        XCTAssertEqual(notifier.events, ["sent c1", "noreply c1 180"])
        XCTAssertEqual(api.sentReports.map(\.accepted), [true])
    }

    /// Device mode: the bolus key's signature (its own Face ID) replaces the separate check and travels with the command.
    func testADevicePhoneSendsTheSignedConfirmation() async throws {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 200)
        let keys = InMemoryDeviceKeyStore()
        _ = try keys.createKeys()
        _ = try keys.createBolusKey()
        let signer = DeviceRemoteCommandSigner(api: FakeSigningAPI(now: now), deviceID: { "server-device-1" }, keys: keys, now: { self.now })
        var stored = TrioRemoteSettings(sharedSecret: "trio-secret", apnsKeyID: "KEY1234567", apnsKeyP8: testP8, maxBolusUnits: 10, maxCarbsGrams: 120)
        stored.pinnedTrio = pinnedTrio
        let store = InMemoryTrioRemoteSettingsStore()
        try store.save(stored, patientID: "p1")
        // A refusing gate proves the separate Face ID check is not asked (the key asks instead).
        let sender = RemoteCommandSender(patientID: "p1", api: api, settingsStore: store, transport: transport, biometrics: FixedBiometrics(result: .refused("not asked")), identity: identity, deviceID: "device-1", pushToken: { "cafe" }, pendingStore: MemoryPendingStore(), notifier: RecordingNotifier(), patientName: "Janek", signer: signer, now: { self.now })
        let outcome = await sender.send(draft)
        guard case .sent = outcome else { return XCTFail("\(outcome)") }
        let authorization = try XCTUnwrap(api.authorized?.device_authorization)
        let padded = authorization.payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let bytes = try XCTUnwrap(Data(base64Encoded: padded + String(repeating: "=", count: (4 - padded.count % 4) % 4)))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual((json["insulin_u"] as? NSNumber)?.decimalValue, Decimal(string: "4.6"))
        XCTAssertEqual(json["carbs_g"] as? Int, 46)
        XCTAssertEqual(json["device_id"] as? String, "server-device-1")
        XCTAssertEqual(json["confirmation"] as? String, "Janek: podać 46 g węglowodanów i 4,6 j insuliny?")
        // The encoded request carries it as device_authorization.
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(api.authorized!)) as? [String: Any])
        XCTAssertNotNil(encoded["device_authorization"] as? [String: Any])

        // Face ID cancelled on the key: nothing is authorized, nothing leaves.
        let refusingKeys = InMemoryDeviceKeyStore(confirm: { _ in .refused("Anulowano.") })
        _ = try refusingKeys.createKeys()
        _ = try refusingKeys.createBolusKey()
        let refusedAPI = FakeRemoteAPI(now: now)
        let refusingSigner = DeviceRemoteCommandSigner(api: FakeSigningAPI(now: now), deviceID: { "server-device-1" }, keys: refusingKeys, now: { self.now })
        let refused = await RemoteCommandSender(patientID: "p1", api: refusedAPI, settingsStore: store, transport: transport, biometrics: FixedBiometrics(result: .confirmed), identity: identity, deviceID: "device-1", pushToken: { "cafe" }, pendingStore: MemoryPendingStore(), notifier: RecordingNotifier(), signer: refusingSigner, now: { self.now }).send(draft)
        XCTAssertEqual(refused, .notSent("Anulowano."))
        XCTAssertNil(refusedAPI.authorized)
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testNothingLeavesWithoutFaceID() async {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 200)
        let outcome = await makeSender(api: api, transport: transport, biometrics: .refused("Anulowano.")).send(draft)
        XCTAssertEqual(outcome, .notSent("Anulowano."))
        XCTAssertNil(api.authorized)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testNothingLeavesWhenTheServerRefuses() async {
        let api = FakeRemoteAPI(now: now)
        api.refusal = APIClientError.conflict(ProblemDetails(type: "t", title: "REMOTE_COMMAND_BLOCKED: Glukoza poniżej 70 mg/dL teraz lub w ostatnich 30 min: bez insuliny.", status: 409, code: "CONFLICT", instance: nil))
        let transport = RecordingTransport(status: 200)
        let outcome = await makeSender(api: api, transport: transport).send(draft)
        XCTAssertEqual(outcome, .notSent("Glukoza poniżej 70 mg/dL teraz lub w ostatnich 30 min: bez insuliny."))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testPhoneLimitsComeFirst() async {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 200)
        let tooMuch = RemoteCommandDraft(source: .bolusScreen, carbsG: 46, insulinU: 12, acknowledgedWarnings: [])
        let outcome = await makeSender(api: api, transport: transport).send(tooMuch)
        XCTAssertEqual(outcome, .notSent("12 j przekracza limit na tym telefonie (10 j)."))
        let offStep = RemoteCommandDraft(source: .bolusScreen, carbsG: 46, insulinU: Decimal(string: "4.62")!, acknowledgedWarnings: [])
        if case .notSent = await makeSender(api: api, transport: transport).send(offStep) {} else { XCTFail("off-step dose sent") }
        let noToken = await makeSender(api: api, transport: transport, token: nil).send(draft)
        if case .notSent = noToken {} else { XCTFail("sent without a reply address") }
        XCTAssertNil(api.authorized)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testAPNsRefusalIsReportedAndNotRetried() async {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 403, body: Data(#"{"reason":"InvalidProviderToken"}"#.utf8))
        let pending = MemoryPendingStore()
        let outcome = await makeSender(api: api, transport: transport, pending: pending).send(draft)
        XCTAssertEqual(outcome, .sendFailed("Nie udało się wysłać: klucz APNs nie pasuje do zespołu, który zbudował Trio, albo jest nieważny"))
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(api.sentReports.map(\.accepted), [false])
        XCTAssertNil(pending.pending)
    }

    func testABolusWithoutCarbsIsABolusCommand() async throws {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 200)
        _ = await makeSender(api: api, transport: transport).send(RemoteCommandDraft(source: .bolusScreen, carbsG: 0, insulinU: Decimal(string: "1.5")!, acknowledgedWarnings: ["INSULIN_WITHOUT_CARBS"]))
        let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: Any]
        let json = try JSONSerialization.jsonObject(with: try TrioSecureMessenger(sharedSecret: "trio-secret").decrypt(body["encrypted_data"] as! String)) as! [String: Any]
        XCTAssertEqual(json["command_type"] as? String, "bolus")
        XCTAssertNil(json["carbs"])
        XCTAssertNil(api.authorized?.meal)
    }

    func testTrioAnswersAreReportedOnceAndToldInPolish() async {
        let api = FakeRemoteAPI(now: now)
        let pending = MemoryPendingStore()
        pending.pending = PendingRemoteCommand(patientID: "p1", commandID: "c1", carbsG: 46, insulinU: Decimal(string: "4.6")!, sentAt: now)
        let notifier = RecordingNotifier()
        let handler = TrioReplyHandler(api: api, pendingStore: pending, notifier: notifier, now: { self.now.addingTimeInterval(20) })
        let initiating: [AnyHashable: Any] = ["command_status": "success", "command_type": "meal", "aps": ["alert": ["title": "Command Successful", "body": "Initiating bolus..."]]]
        let started: [AnyHashable: Any] = ["command_status": "success", "command_type": "meal", "aps": ["alert": ["title": "Command Successful", "body": "Bolus started"]]]

        let first = await handler.handle(userInfo: initiating, key: "n1", deliveredAt: now.addingTimeInterval(5))
        XCTAssertTrue(first)
        XCTAssertEqual(notifier.events, [])
        await handler.handle(userInfo: started, key: "n2", deliveredAt: now.addingTimeInterval(15))
        await handler.handle(userInfo: started, key: "n2", deliveredAt: now.addingTimeInterval(15))
        XCTAssertEqual(api.replyReports.map(\.message), ["Initiating bolus...", "Bolus started"])
        XCTAssertEqual(notifier.events, ["cancel c1", "finished c1 ✅ Bolus podany | Trio rozpoczęło bolus 4,6 j na 46 g węglowodanów.", "removed n2"])
        XCTAssertNil(pending.pending)
        XCTAssertEqual(pending.handledReplyKeys, ["n1", "n2"])
        let notTrio = await handler.handle(userInfo: ["gluco": ["type": "meal_description"]], key: "n3", deliveredAt: nil)
        XCTAssertFalse(notTrio)
    }

    func testAnOldAnswerLeftInNotificationCenterIsNotTheNewCommandsAnswer() async {
        let api = FakeRemoteAPI(now: now)
        let pending = MemoryPendingStore()
        pending.pending = PendingRemoteCommand(patientID: "p1", commandID: "c2", carbsG: 46, insulinU: 4, sentAt: now)
        let notifier = RecordingNotifier()
        let handler = TrioReplyHandler(api: api, pendingStore: pending, notifier: notifier, now: { self.now.addingTimeInterval(60) })
        let oldFailure: [AnyHashable: Any] = ["command_status": "failed", "aps": ["alert": ["title": "Command Failed", "body": "Command rejected: current IOB is not available."]]]
        await handler.handle(userInfo: oldFailure, key: "old", deliveredAt: now.addingTimeInterval(-600))
        XCTAssertTrue(api.replyReports.isEmpty)
        XCTAssertEqual(pending.pending?.commandID, "c2")
    }

    func testAFailedReportTellsTheCaregiverOnceAndIsRetriedLater() async {
        let api = FakeRemoteAPI(now: now)
        api.replyFails = true
        let pending = MemoryPendingStore()
        pending.pending = PendingRemoteCommand(patientID: "p1", commandID: "c1", carbsG: 46, insulinU: 4, sentAt: now)
        let notifier = RecordingNotifier()
        let handler = TrioReplyHandler(api: api, pendingStore: pending, notifier: notifier, now: { self.now.addingTimeInterval(20) })
        let started: [AnyHashable: Any] = ["command_status": "success", "aps": ["alert": ["title": "Command Successful", "body": "Bolus started"]]]
        await handler.handle(userInfo: started, key: "n1", deliveredAt: now.addingTimeInterval(15))
        XCTAssertEqual(notifier.events, ["cancel c1", "finished c1 ✅ Bolus podany | Trio rozpoczęło bolus 4 j na 46 g węglowodanów."])
        XCTAssertEqual(pending.pending?.finalNotified, true, "kept until the server knows")
        XCTAssertFalse(pending.handledReplyKeys.contains("n1"))

        api.replyFails = false
        await handler.handle(userInfo: started, key: "n1", deliveredAt: now.addingTimeInterval(15))
        XCTAssertNil(pending.pending)
        XCTAssertEqual(notifier.events.filter { $0.hasPrefix("finished") }.count, 1)
    }

    func testThisPhoneWaitsForTrioOnlyAsLongAsTrioMayStillAnswer() async {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 200)
        let pending = MemoryPendingStore()
        pending.pending = PendingRemoteCommand(patientID: "p2", commandID: "c0", carbsG: 20, insulinU: 2, sentAt: now.addingTimeInterval(-120), patientName: "Ewa")
        // Still waiting for Trio: said with the time left, nothing sent.
        api.serverStatus = "SENT"
        let blocked = await makeSender(api: api, transport: transport, pending: pending).send(draft)
        XCTAssertEqual(blocked, .notSent("Poprzednie polecenie (Ewa) czeka na odpowiedź Trio, jeszcze 1:30."))
        XCTAssertTrue(transport.requests.isEmpty)

        // Trio did not answer in time: released at once (the server asks to acknowledge a bolus that MAY have been
        // given). Another patient's Trio may still answer late, so no answer is taken for this command.
        api.serverStatus = "NO_REPLY"
        let afterNoReply = await makeSender(api: api, transport: transport, pending: pending).send(draft)
        guard case .sent = afterNoReply else { return XCTFail("\(afterNoReply)") }
        XCTAssertEqual(pending.pending?.ignoresTrioReplies, true)
        let handler = TrioReplyHandler(api: api, pendingStore: pending, notifier: RecordingNotifier(), now: { self.now })
        let taken = await handler.handle(userInfo: ["command_status": "success", "aps": ["alert": ["title": "Trio", "body": "Bolus started"]]] as [AnyHashable: Any], key: "late", deliveredAt: now)
        XCTAssertTrue(taken, "Trio's banner is still hidden")
        XCTAssertTrue(api.replyReports.isEmpty, "a late answer of the other patient's Trio is not this command's")

        // The same patient: released after NO_REPLY too, answers are taken as before.
        pending.pending = PendingRemoteCommand(patientID: "p1", commandID: "c0", carbsG: 20, insulinU: 2, sentAt: now.addingTimeInterval(-200))
        let samePatient = await makeSender(api: api, transport: transport, pending: pending).send(draft)
        guard case .sent = samePatient else { return XCTFail("\(samePatient)") }
        XCTAssertNil(pending.pending?.ignoresTrioReplies)

        // The server cannot be asked: the phone stops waiting after Trio's answer time.
        pending.pending = PendingRemoteCommand(patientID: "p1", commandID: "c0", carbsG: 20, insulinU: 2, sentAt: now.addingTimeInterval(-60))
        api.commandUnavailable = true
        let unknown = await makeSender(api: api, transport: transport, pending: pending).send(draft)
        XCTAssertEqual(unknown, .notSent("Poprzednie polecenie czeka na odpowiedź Trio, jeszcze 2:30."))
        pending.pending = PendingRemoteCommand(patientID: "p1", commandID: "c0", carbsG: 20, insulinU: 2, sentAt: now.addingTimeInterval(-215))
        let later = await makeSender(api: api, transport: transport, pending: pending).send(draft)
        if case .sent = later {} else { XCTFail("\(later)") }

        // Settled on the server (e.g. matched in Nightscout): the phone stops waiting.
        api.commandUnavailable = false
        pending.pending = PendingRemoteCommand(patientID: "p2", commandID: "c0", carbsG: 20, insulinU: 2, sentAt: now.addingTimeInterval(-30))
        api.serverStatus = "SUCCEEDED"
        let sent = await makeSender(api: api, transport: transport, pending: pending).send(draft)
        if case .sent = sent {} else { XCTFail("\(sent)") }
        XCTAssertNil(pending.pending?.ignoresTrioReplies)
    }

    func testTheCommandCarriesTheTimeTheCaregiverConfirmed() async throws {
        let api = FakeRemoteAPI(now: now)
        let transport = RecordingTransport(status: 200)
        let confirmed = RemoteCommandDraft(source: .bolusScreen, carbsG: 46, insulinU: Decimal(string: "4.6")!, acknowledgedWarnings: [], confirmedAt: now.addingTimeInterval(-90))
        _ = await makeSender(api: api, transport: transport).send(confirmed)
        let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: Any]
        let json = try JSONSerialization.jsonObject(with: try TrioSecureMessenger(sharedSecret: "trio-secret").decrypt(body["encrypted_data"] as! String)) as! [String: Any]
        XCTAssertEqual(json["timestamp"] as? Double, now.addingTimeInterval(-90).timeIntervalSince1970)
    }

    func testAMealEatenLaterDatesTheCarbsWhenTheServerCheckedTheDose() async throws {
        let api = FakeRemoteAPI(now: now)
        api.carbsAt = "2026-10-19T12:15:00.000Z"
        let transport = RecordingTransport(status: 200)
        var later = RemoteCommandDraft(source: .bolusScreen, carbsG: 46, insulinU: Decimal(string: "4.6")!, acknowledgedWarnings: [])
        later.mealInMinutes = 15
        _ = await makeSender(api: api, transport: transport).send(later)
        XCTAssertEqual(api.authorized?.meal_in_minutes, 15)
        let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: Any]
        let json = try JSONSerialization.jsonObject(with: try TrioSecureMessenger(sharedSecret: "trio-secret").decrypt(body["encrypted_data"] as! String)) as! [String: Any]
        XCTAssertEqual(json["scheduled_time"] as? Double, ServerDate.parse("2026-10-19T12:15:00.000Z")!.timeIntervalSince1970)

        // A server that did not date them (older): the carbs stay now, as the dose it checked.
        let olderAPI = FakeRemoteAPI(now: now)
        let olderTransport = RecordingTransport(status: 200)
        _ = await makeSender(api: olderAPI, transport: olderTransport).send(later)
        let olderBody = try JSONSerialization.jsonObject(with: olderTransport.requests[0].httpBody!) as! [String: Any]
        let olderJSON = try JSONSerialization.jsonObject(with: try TrioSecureMessenger(sharedSecret: "trio-secret").decrypt(olderBody["encrypted_data"] as! String)) as! [String: Any]
        XCTAssertNil(olderJSON["scheduled_time"])
    }

    func testAFailedBolusSaysSoInTheTitle() {
        let pending = PendingRemoteCommand(patientID: "p1", commandID: "c1", carbsG: 16, insulinU: Decimal(string: "2.4")!, sentAt: now)
        let result = TrioReplyHandler.resultNotification(success: false, text: "Węglowodany zapisane w Trio, bolus odrzucony: bolus 2.4 j przekracza maksymalny bolus w Trio (2 j)", pending: pending)
        XCTAssertEqual(result.title, "❌ Bolus nie został podany")
        XCTAssertEqual(result.body, "Węglowodany zapisane w Trio, bolus odrzucony: bolus 2.4 j przekracza maksymalny bolus w Trio (2 j)")
        XCTAssertEqual(TrioReplyHandler.resultNotification(success: false, text: "Błąd: Remote Control jest wyłączone w Trio", pending: pending).body, "Remote Control jest wyłączone w Trio")
    }
}

private final class FakeRemoteAPI: RemoteCommandsAPI {
    let now: Date
    var refusal: Error?
    var commandPatientID: String?
    var authorized: RemoteCommandAuthorizeRequest?
    /// What the server answers for a meal eaten later (nil: an older server, or no such meal).
    var carbsAt: String?
    var sentReports: [(accepted: Bool, message: String?)] = []
    var replyReports: [(success: Bool, message: String)] = []

    init(now: Date) { self.now = now }

    func command(status: String, message: String? = nil) -> RemoteCommand {
        let formatter = ISO8601DateFormatter()
        return RemoteCommand(id: "c1", patient_id: commandPatientID, status: status, status_message: message, source: "BOLUS_SCREEN", carbs_g: 46, insulin_u: 4.6, icr_g_per_u: 10, meal_description: nil, conversation_id: nil, proposal_id: nil, sent_by_me: true, authorized_at: formatter.string(from: now), send_deadline: formatter.string(from: now.addingTimeInterval(120)), sent_at: nil, answered_at: nil, meal_record_id: nil, loop_action_id: nil, warnings: [])
    }

    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview { fatalError() }
    func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand {
        if let refusal { throw refusal }
        authorized = request
        var authorizedCommand = command(status: "AUTHORIZED")
        authorizedCommand.carbs_at = carbsAt
        return authorizedCommand
    }
    func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand {
        sentReports.append((accepted, message))
        return command(status: accepted ? "SENT" : "SEND_FAILED")
    }
    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand {
        replyReports.append((success, message))
        if replyFails { throw URLError(.notConnectedToInternet) }
        if message.hasPrefix("Initiating") { return command(status: "TRIO_ACCEPTED") }
        return success ? command(status: "SUCCEEDED", message: "Bolus podany") : command(status: "REJECTED", message: "Błąd: \(message)")
    }
    func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] { [] }
    var serverStatus = "SENT"
    var replyFails = false
    var commandUnavailable = false
    func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand {
        if commandUnavailable { throw URLError(.notConnectedToInternet) }
        return command(status: serverStatus)
    }
    func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse {
        TrioRemoteTargetResponse(patient_id: "p1", trio: TrioRemoteTarget(status: "READY", device_token: String(repeating: "ab", count: 32), bundle_id: "org.nightscout.TEAM123456.trio", team_id: "TEAM123456", apns_environment: "production", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil))
    }
}

private final class RecordingTransport: APNsTransport {
    let status: Int
    let body: Data
    var requests: [URLRequest] = []
    init(status: Int, body: Data = Data()) {
        self.status = status
        self.body = body
    }
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        requests.append(request)
        return (status, body)
    }
}

private struct FixedBiometrics: BiometricGate {
    let result: BiometricResult
    func confirm(reason: String) async -> BiometricResult { result }
}

private final class MemoryPendingStore: PendingRemoteCommandStore {
    var pending: PendingRemoteCommand?
    var handledReplyKeys: [String] = []
}

private final class RecordingNotifier: RemoteCommandNotifier {
    var events: [String] = []
    var summaries: [String] = []
    func commandSent(commandID: String, patientID: String, summary: String) { events.append("sent \(commandID)"); summaries.append(summary) }
    func scheduleNoReply(commandID: String, patientID: String, after seconds: TimeInterval) { events.append("noreply \(commandID) \(Int(seconds))") }
    func cancelNoReply(commandID: String) { events.append("cancel \(commandID)") }
    func commandFinished(commandID: String, patientID: String, title: String, body: String) { events.append("finished \(commandID) \(title) | \(body)") }
    func removeDelivered(identifiers: [String]) { events.append("removed \(identifiers.joined(separator: ","))") }
}

private extension PinnedTrio {
    func withDate(_ date: Date) -> PinnedTrio { PinnedTrio(tokenHash: tokenHash, bundleID: bundleID, teamID: teamID, pinnedAt: date) }
}
