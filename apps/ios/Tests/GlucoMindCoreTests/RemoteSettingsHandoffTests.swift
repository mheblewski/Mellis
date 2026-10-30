import CryptoKit
import XCTest
@testable import GlucoMindCore

/// "Przekaż moje ustawienia Trio/Loop" (docs/device-auth-api.md §8): the package bytes, ECIES with software keys
/// (the same SecKey algorithm the Secure Enclave runs), signatures, recipients and saving into the Keychain models.
final class RemoteSettingsHandoffTests: XCTestCase {
    private let patientID = "11111111-1111-4111-8111-111111111111"
    private let ownerDeviceID = "22222222-2222-4222-8222-222222222222"
    private let aniaPhoneID = "33333333-3333-4333-8333-333333333333"
    private let aniaPadID = "44444444-4444-4444-8444-444444444444"
    private let team = "ABCDE12345"
    /// A throwaway key made by the test, never a real APNs key.
    private let p8 = P256.Signing.PrivateKey().pemRepresentation

    private func trioSettings(secret: String = "fikcyjny-sekret-zosi") -> RemoteSettingsPackage.Settings {
        RemoteSettingsPackage.Settings(
            secret: secret, apnsKeyID: "KEYID12345", apnsKeyP8: p8, returnKeyID: nil, returnKeyP8: nil,
            maxBolusUnits: Decimal(string: "4.5")!, maxCarbsGrams: 80, bolusIncrement: Decimal(string: "0.05")!,
            pinned: .init(token_hash: PinnedTrio.hash("trio-token-zosi"), bundle_id: "org.nightscout.\(team).trio", team_id: team)
        )
    }

    private func package(to deviceID: String, kind: HandoffLoopKind = .trio, settings: RemoteSettingsPackage.Settings? = nil) -> RemoteSettingsPackage {
        RemoteSettingsPackage(patientID: patientID, patientName: "Zosia", fromUserID: "55555555-5555-4555-8555-555555555555", fromName: "Tomek",
                              fromDeviceID: ownerDeviceID, toDeviceID: deviceID, loopKind: kind, createdAt: "2026-10-29T08:00:00.000Z", settings: settings ?? trioSettings())
    }

    private func handoff(to deviceID: String, recipientKey: HandoffRecipientKey, kind: HandoffLoopKind = .trio, sender: SoftwareDeviceSigningKey) -> RemoteSettingsHandoff {
        RemoteSettingsHandoff(handoff_id: "66666666-6666-4666-8666-666666666666", patient_id: patientID, patient_name: "Zosia", from_user_id: "55555555-5555-4555-8555-555555555555",
                              from_name: "Tomek", from_device_id: ownerDeviceID, from_device_public_key: sender.publicKeyBase64, to_user_id: "77777777-7777-4777-8777-777777777777",
                              to_name: "Ania", to_device_id: deviceID, to_device_name: "iPhone Ani", loop_kind: kind, recipient_key: recipientKey,
                              created_at: "2026-10-29T08:00:00.000Z", expires_at: "2026-11-05T08:00:00.000Z", consumed_at: nil)
    }

    private func device(_ id: String, key: SoftwareDeviceSigningKey, kind: HandoffRecipientKey = .bolus) -> HandoffDevice {
        HandoffDevice(device_id: id, name: "iPhone Ani", recipient_key: kind, encryption_public_key: key.publicKeyBase64)
    }

    // MARK: Bytes

    func testTrioPackageIsEncodedByteForByte() {
        let settings = RemoteSettingsPackage.Settings(
            secret: "sekret/ąę\"", apnsKeyID: "KEYID12345", apnsKeyP8: "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----",
            returnKeyID: nil, returnKeyP8: nil, maxBolusUnits: 5, maxCarbsGrams: 100, bolusIncrement: Decimal(string: "0.05")!,
            pinned: .init(token_hash: "ab12", bundle_id: "org.nightscout.ABCDE12345.trio", team_id: "ABCDE12345")
        )
        let encoded = String(decoding: package(to: aniaPhoneID, settings: settings).encoded(), as: UTF8.self)
        XCTAssertEqual(encoded, #"{"v":1,"type":"remote_settings_handoff","patient_id":"11111111-1111-4111-8111-111111111111","patient_name":"Zosia","from_user_id":"55555555-5555-4555-8555-555555555555","from_name":"Tomek","from_device_id":"22222222-2222-4222-8222-222222222222","to_device_id":"33333333-3333-4333-8333-333333333333","loop_kind":"trio","created_at":"2026-10-29T08:00:00.000Z","settings":{"shared_secret":"sekret/ąę\"","apns_key_id":"KEYID12345","apns_key_p8":"-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----","return_key_id":null,"return_key_p8":null,"max_bolus_u":"5","max_carbs_g":100,"bolus_increment_u":"0.05","pinned":{"token_hash":"ab12","bundle_id":"org.nightscout.ABCDE12345.trio","team_id":"ABCDE12345"}}}"#)
        XCTAssertEqual(try RemoteSettingsPackage.decode(Data(encoded.utf8)), package(to: aniaPhoneID, settings: settings))
    }

    func testLoopPackageIsEncodedByteForByte() {
        let settings = RemoteSettingsPackage.Settings(
            secret: "otpauth://totp/Loop?secret=ABC&period=30", apnsKeyID: "KEYID12345", apnsKeyP8: "P8", teamID: "LOOPT12345",
            returnKeyID: "RETKEY1234", returnKeyP8: "R8", maxBolusUnits: Decimal(string: "2.5")!, maxCarbsGrams: 60, bolusIncrement: Decimal(string: "0.1")!,
            pinned: .init(token_hash: "cd34", bundle_id: "com.LOOPT12345.loopkit.Loop", team_id: "LOOPT12345")
        )
        let encoded = String(decoding: package(to: aniaPhoneID, kind: .loop, settings: settings).encoded(), as: UTF8.self)
        XCTAssertTrue(encoded.hasSuffix(#""loop_kind":"loop","created_at":"2026-10-29T08:00:00.000Z","settings":{"otp_url":"otpauth://totp/Loop?secret=ABC&period=30","apns_key_id":"KEYID12345","apns_key_p8":"P8","team_id":"LOOPT12345","return_key_id":"RETKEY1234","return_key_p8":"R8","max_bolus_u":"2.5","max_carbs_g":60,"bolus_increment_u":"0.1","pinned":{"token_hash":"cd34","bundle_id":"com.LOOPT12345.loopkit.Loop","team_id":"LOOPT12345"}}}"#), encoded)
        XCTAssertEqual(try RemoteSettingsPackage.decode(Data(encoded.utf8)).settings, settings)
    }

    func testSignedMessageMatchesTheServer() {
        // modules/device-auth/domain/device-crypto.spec.ts pins the same bytes.
        let message = RemoteSettingsHandoffCrypto.message(patientID: patientID, fromDeviceID: ownerDeviceID, toDeviceID: aniaPhoneID, loopKind: .trio, recipientKey: .bolus, ciphertext: "BAEC")
        XCTAssertEqual(String(decoding: message, as: UTF8.self), "mellis-remote-settings-v1\n11111111-1111-4111-8111-111111111111\n22222222-2222-4222-8222-222222222222\n33333333-3333-4333-8333-333333333333\ntrio\nbolus\nBAEC")
    }

    func testMalformedPackagesAreRefused() {
        XCTAssertThrowsError(try RemoteSettingsPackage.decode(Data("{}".utf8)))
        let encoded = String(decoding: package(to: aniaPhoneID).encoded(), as: UTF8.self)
        XCTAssertThrowsError(try RemoteSettingsPackage.decode(Data(encoded.replacingOccurrences(of: #""v":1"#, with: #""v":2"#).utf8)))
        XCTAssertThrowsError(try RemoteSettingsPackage.decode(Data(encoded.replacingOccurrences(of: #""max_bolus_u":"4.5""#, with: #""max_bolus_u":"-4.5""#).utf8)))
    }

    // MARK: Encryption

    func testRoundTripWithSoftwareKeysAndOneFaceID() async throws {
        let owner = SoftwareDeviceSigningKey()
        let prompts = PromptLog()
        let aniaBolus = SoftwareDeviceSigningKey(confirm: { prompt in await prompts.add(prompt); return .confirmed })
        let sealed = try await RemoteSettingsHandoffCrypto.seal(package(to: aniaPhoneID), for: device(aniaPhoneID, key: aniaBolus), signer: owner)
        XCTAssertEqual(sealed.recipient_key, .bolus)
        let ciphertext = try XCTUnwrap(Data(base64Encoded: sealed.ciphertext))
        // ECIES: ephemeral key ‖ ciphertext ‖ tag; nothing readable on the way.
        XCTAssertEqual(ciphertext.first, 0x04)
        XCTAssertEqual(ciphertext.count, 65 + package(to: aniaPhoneID).encoded().count + 16)
        XCTAssertNil(String(data: ciphertext, encoding: .utf8).flatMap { $0.contains("fikcyjny") ? $0 : nil })

        let consumed = ConsumedHandoff(handoff: handoff(to: aniaPhoneID, recipientKey: .bolus, sender: owner), ciphertext: sealed.ciphertext, sender_signature: sealed.sender_signature)
        let opened = try await RemoteSettingsHandoffCrypto.open(consumed, thisDeviceID: aniaPhoneID, keys: DeviceKeyPair(device: SoftwareDeviceSigningKey(), bolus: aniaBolus), prompt: "Zapisać?")
        XCTAssertEqual(opened, package(to: aniaPhoneID))
        let asked = await prompts.all
        XCTAssertEqual(asked, ["Zapisać?"])
    }

    func testDeviceKeyDecryptsWhileThePhoneHasNoBolusKey() async throws {
        let owner = SoftwareDeviceSigningKey()
        let aniaDevice = SoftwareDeviceSigningKey()
        let sealed = try await RemoteSettingsHandoffCrypto.seal(package(to: aniaPhoneID), for: device(aniaPhoneID, key: aniaDevice, kind: .device), signer: owner)
        let consumed = ConsumedHandoff(handoff: handoff(to: aniaPhoneID, recipientKey: .device, sender: owner), ciphertext: sealed.ciphertext, sender_signature: sealed.sender_signature)
        let opened = try await RemoteSettingsHandoffCrypto.open(consumed, thisDeviceID: aniaPhoneID, keys: DeviceKeyPair(device: aniaDevice), prompt: "x")
        XCTAssertEqual(opened.settings.secret, "fikcyjny-sekret-zosi")
    }

    func testCancelledFaceIDKeepsNothingAndCanBeRetried() async throws {
        let owner = SoftwareDeviceSigningKey()
        let aniaBolus = SoftwareDeviceSigningKey(confirm: { _ in .refused("Anulowano.") })
        let sealed = try await RemoteSettingsHandoffCrypto.seal(package(to: aniaPhoneID), for: device(aniaPhoneID, key: aniaBolus), signer: owner)
        let consumed = ConsumedHandoff(handoff: handoff(to: aniaPhoneID, recipientKey: .bolus, sender: owner), ciphertext: sealed.ciphertext, sender_signature: sealed.sender_signature)
        await assertThrows(.cancelled) { try await RemoteSettingsHandoffCrypto.open(consumed, thisDeviceID: self.aniaPhoneID, keys: DeviceKeyPair(device: SoftwareDeviceSigningKey(), bolus: aniaBolus), prompt: "x") }
    }

    func testAnotherDeviceCannotUseThePackage() async throws {
        let owner = SoftwareDeviceSigningKey()
        let phoneKey = SoftwareDeviceSigningKey()
        let padKey = SoftwareDeviceSigningKey()
        let sealed = try await RemoteSettingsHandoffCrypto.seal(package(to: aniaPhoneID), for: device(aniaPhoneID, key: phoneKey), signer: owner)
        let consumed = ConsumedHandoff(handoff: handoff(to: aniaPhoneID, recipientKey: .bolus, sender: owner), ciphertext: sealed.ciphertext, sender_signature: sealed.sender_signature)
        // The iPad is not the phone the server delivered it to.
        await assertThrows(.wrongRecipient) { try await RemoteSettingsHandoffCrypto.open(consumed, thisDeviceID: self.aniaPadID, keys: DeviceKeyPair(device: padKey, bolus: padKey), prompt: "x") }

        // A server relabelling the phone's copy for the iPad: the signature names the phone.
        let relabelled = ConsumedHandoff(handoff: handoff(to: aniaPadID, recipientKey: .bolus, sender: owner), ciphertext: sealed.ciphertext, sender_signature: sealed.sender_signature)
        await assertThrows(.signatureInvalid) { try await RemoteSettingsHandoffCrypto.open(relabelled, thisDeviceID: self.aniaPadID, keys: DeviceKeyPair(device: padKey, bolus: padKey), prompt: "x") }

        // Even signed for the iPad, the iPad's key cannot open what was encrypted to the phone.
        let signedForPad = try await owner.sign(RemoteSettingsHandoffCrypto.message(patientID: patientID, fromDeviceID: ownerDeviceID, toDeviceID: aniaPadID, loopKind: .trio, recipientKey: .bolus, ciphertext: sealed.ciphertext), prompt: nil)
        let moved = ConsumedHandoff(handoff: handoff(to: aniaPadID, recipientKey: .bolus, sender: owner), ciphertext: sealed.ciphertext, sender_signature: signedForPad.base64EncodedString())
        await assertThrows(.malformed) { try await RemoteSettingsHandoffCrypto.open(moved, thisDeviceID: self.aniaPadID, keys: DeviceKeyPair(device: padKey, bolus: padKey), prompt: "x") }

        // Encrypted to the iPad's key and signed for it, but the package inside names the phone: refused after decrypting.
        let inner = try await RemoteSettingsHandoffCrypto.seal(package(to: aniaPhoneID), for: device(aniaPhoneID, key: padKey), signer: owner)
        let resigned = try await owner.sign(RemoteSettingsHandoffCrypto.message(patientID: patientID, fromDeviceID: ownerDeviceID, toDeviceID: aniaPadID, loopKind: .trio, recipientKey: .bolus, ciphertext: inner.ciphertext), prompt: nil)
        let replayed = ConsumedHandoff(handoff: handoff(to: aniaPadID, recipientKey: .bolus, sender: owner), ciphertext: inner.ciphertext, sender_signature: resigned.base64EncodedString())
        await assertThrows(.wrongRecipient) { try await RemoteSettingsHandoffCrypto.open(replayed, thisDeviceID: self.aniaPadID, keys: DeviceKeyPair(device: padKey, bolus: padKey), prompt: "x") }
    }

    func testTamperedCiphertextOrSignatureIsRefused() async throws {
        let owner = SoftwareDeviceSigningKey()
        let aniaBolus = SoftwareDeviceSigningKey()
        let keys = DeviceKeyPair(device: SoftwareDeviceSigningKey(), bolus: aniaBolus)
        let sealed = try await RemoteSettingsHandoffCrypto.seal(package(to: aniaPhoneID), for: device(aniaPhoneID, key: aniaBolus), signer: owner)
        var bytes = try XCTUnwrap(Data(base64Encoded: sealed.ciphertext))
        bytes[bytes.count - 20] ^= 0x01
        let flipped = bytes.base64EncodedString()
        let envelope = handoff(to: aniaPhoneID, recipientKey: .bolus, sender: owner)

        // A changed ciphertext breaks the sender's signature.
        await assertThrows(.signatureInvalid) { try await RemoteSettingsHandoffCrypto.open(ConsumedHandoff(handoff: envelope, ciphertext: flipped, sender_signature: sealed.sender_signature), thisDeviceID: self.aniaPhoneID, keys: keys, prompt: "x") }
        // A signature by anyone but the owner's phone.
        let forged = try await SoftwareDeviceSigningKey().sign(RemoteSettingsHandoffCrypto.message(patientID: patientID, fromDeviceID: ownerDeviceID, toDeviceID: aniaPhoneID, loopKind: .trio, recipientKey: .bolus, ciphertext: sealed.ciphertext), prompt: nil)
        await assertThrows(.signatureInvalid) { try await RemoteSettingsHandoffCrypto.open(ConsumedHandoff(handoff: envelope, ciphertext: sealed.ciphertext, sender_signature: forged.base64EncodedString()), thisDeviceID: self.aniaPhoneID, keys: keys, prompt: "x") }
        await assertThrows(.signatureInvalid) { try await RemoteSettingsHandoffCrypto.open(ConsumedHandoff(handoff: envelope, ciphertext: sealed.ciphertext, sender_signature: "AAAA"), thisDeviceID: self.aniaPhoneID, keys: keys, prompt: "x") }
        // The envelope says Loop, the signature covers Trio.
        let asLoop = handoff(to: aniaPhoneID, recipientKey: .bolus, kind: .loop, sender: owner)
        await assertThrows(.signatureInvalid) { try await RemoteSettingsHandoffCrypto.open(ConsumedHandoff(handoff: asLoop, ciphertext: sealed.ciphertext, sender_signature: sealed.sender_signature), thisDeviceID: self.aniaPhoneID, keys: keys, prompt: "x") }
        // Signed again after the change (as if the owner's phone had a bug): AES-GCM still refuses it.
        let resigned = try await owner.sign(RemoteSettingsHandoffCrypto.message(patientID: patientID, fromDeviceID: ownerDeviceID, toDeviceID: aniaPhoneID, loopKind: .trio, recipientKey: .bolus, ciphertext: flipped), prompt: nil)
        await assertThrows(.malformed) { try await RemoteSettingsHandoffCrypto.open(ConsumedHandoff(handoff: envelope, ciphertext: flipped, sender_signature: resigned.base64EncodedString()), thisDeviceID: self.aniaPhoneID, keys: keys, prompt: "x") }
    }

    // MARK: Keychain models

    func testSavesTrioSettingsAsIfTypedAndReadyToSend() throws {
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        try RemoteSettingsHandoffImporter.save(package(to: aniaPhoneID), trioStore: trio, loopStore: loop, now: Date(timeIntervalSince1970: 1_800_000_000))
        let saved = try XCTUnwrap(trio.load(patientID: patientID))
        XCTAssertEqual(saved.sharedSecret, "fikcyjny-sekret-zosi")
        XCTAssertEqual(saved.maxBolusUnits, Decimal(string: "4.5"))
        XCTAssertEqual(saved.maxCarbsGrams, 80)
        XCTAssertEqual(saved.limitsReviewed, true)
        XCTAssertEqual(saved.pinnedTrio, PinnedTrio(tokenHash: PinnedTrio.hash("trio-token-zosi"), bundleID: "org.nightscout.\(team).trio", teamID: team, pinnedAt: Date(timeIntervalSince1970: 1_800_000_000)))
        XCTAssertTrue(saved.isComplete(glucoMindTeamID: team))
        // The Trio in Nightscout is the one the owner confirmed: "Gotowe do wysyłania" at once.
        let target = TrioRemoteTarget(status: "READY", device_token: "trio-token-zosi", bundle_id: "org.nightscout.\(team).trio", team_id: team, apns_environment: "sandbox", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil)
        XCTAssertEqual(TrioPatientGuard.pin(settings: saved, target: target, patientID: patientID, store: trio), .confirmed)
        XCTAssertTrue(try loop.patientIDs().isEmpty)
    }

    func testSavesLoopSettings() throws {
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        let settings = RemoteSettingsPackage.Settings(
            secret: "otpauth://totp/Loop?secret=JBSWY3DPEHPK3PXP&period=30", apnsKeyID: "KEYID12345", apnsKeyP8: p8, teamID: nil,
            returnKeyID: nil, returnKeyP8: nil, maxBolusUnits: 3, maxCarbsGrams: 50, bolusIncrement: Decimal(string: "0.05")!,
            pinned: .init(token_hash: "ef56", bundle_id: "com.\(team).loopkit.Loop", team_id: team)
        )
        try RemoteSettingsHandoffImporter.save(package(to: aniaPhoneID, kind: .loop, settings: settings), trioStore: trio, loopStore: loop)
        let saved = try XCTUnwrap(loop.load(patientID: patientID))
        XCTAssertEqual(saved.otpURL, settings.secret)
        XCTAssertEqual(saved.pinnedLoop?.tokenHash, "ef56")
        XCTAssertTrue(saved.isComplete(glucoMindTeamID: team))
        XCTAssertNil(try trio.load(patientID: patientID))
    }

    func testRefusesASecretOrLoopOfAnotherPatientOnThisPhone() throws {
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        try trio.save(TrioRemoteSettings(sharedSecret: "fikcyjny-sekret-zosi"), patientID: "other")
        XCTAssertThrowsError(try RemoteSettingsHandoffImporter.save(package(to: aniaPhoneID), trioStore: trio, loopStore: loop)) {
            XCTAssertEqual($0 as? RemoteSettingsHandoffError, .secretUsedByOtherPatient)
        }
        try trio.save(TrioRemoteSettings(sharedSecret: "inny", pinnedTrio: PinnedTrio(tokenHash: PinnedTrio.hash("trio-token-zosi"), bundleID: "b", teamID: team, pinnedAt: Date())), patientID: "other")
        XCTAssertThrowsError(try RemoteSettingsHandoffImporter.save(package(to: aniaPhoneID), trioStore: trio, loopStore: loop)) {
            XCTAssertEqual($0 as? RemoteSettingsHandoffError, .loopUsedByOtherPatient)
        }
        XCTAssertNil(try trio.load(patientID: patientID))
        // "other" is not a patient of this session (a stale id): the package is saved.
        try RemoteSettingsHandoffImporter.save(package(to: aniaPhoneID), trioStore: trio, loopStore: loop, scope: RemotePatientScope(visiblePatientIDs: [patientID]))
        XCTAssertNotNil(try trio.load(patientID: patientID))
    }

    func testOnlyCompleteConfirmedSettingsAreHandedOver() {
        var settings = TrioRemoteSettings(sharedSecret: "s", apnsKeyID: "KEYID12345", apnsKeyP8: p8, pinnedTrio: PinnedTrio(tokenHash: "h", bundleID: "b", teamID: team, pinnedAt: Date()))
        XCTAssertNil(RemoteSettingsPackage.Settings(trio: settings, glucoMindTeamID: team), "limits not reviewed")
        settings.limitsReviewed = true
        XCTAssertNotNil(RemoteSettingsPackage.Settings(trio: settings, glucoMindTeamID: team))
        settings.pinnedTrio = nil
        XCTAssertNil(RemoteSettingsPackage.Settings(trio: settings, glucoMindTeamID: team))
    }

    // MARK: Flows

    func testOwnerSendsOneSealedCopyPerPhoneAndRecipientSavesIt() async throws {
        let api = FakeHandoffAPI()
        let ownerKeys = InMemoryDeviceKeyStore(keys: DeviceKeyPair(device: SoftwareDeviceSigningKey()))
        let ownerTrio = InMemoryTrioRemoteSettingsStore()
        var owned = TrioRemoteSettings(sharedSecret: "fikcyjny-sekret-zosi", apnsKeyID: "KEYID12345", apnsKeyP8: p8, maxBolusUnits: 4, maxCarbsGrams: 70,
                                       pinnedTrio: PinnedTrio(tokenHash: PinnedTrio.hash("trio-token-zosi"), bundleID: "org.nightscout.\(team).trio", teamID: team, pinnedAt: Date()))
        owned.limitsReviewed = true
        try ownerTrio.save(owned, patientID: patientID)
        let aniaPhone = SoftwareDeviceSigningKey()
        let aniaPadDevice = SoftwareDeviceSigningKey()
        api.devices = [device(aniaPhoneID, key: aniaPhone), device(aniaPadID, key: aniaPadDevice, kind: .device)]
        let confirmations = PromptLog()
        let sender = RemoteSettingsHandoffSender(api: api, keys: ownerKeys, deviceID: { self.ownerDeviceID }, trioStore: ownerTrio, loopStore: InMemoryLoopRemoteSettingsStore(),
                                                 glucoMindTeamID: team, confirm: { prompt in await confirmations.add(prompt); return .confirmed })
        XCTAssertNil(sender.handableSettings(patientID: patientID, loopKind: .loop))
        let count = try await sender.send(patientID: patientID, patientName: "Zosia", fromUserID: "u-tomek", fromName: "Tomek", toUserID: "u-ania", toName: "Ania", loopKind: .trio)
        XCTAssertEqual(count, 2)
        let asked = await confirmations.all
        XCTAssertEqual(asked, ["Przekazać Twoje ustawienia Trio dla: Zosia osobie Ania?"])
        let body = try XCTUnwrap(api.created)
        XCTAssertEqual(body.to_user_id, "u-ania")
        XCTAssertEqual(body.packages.map(\.to_device_id), [aniaPhoneID, aniaPadID])
        XCTAssertEqual(body.packages.map(\.recipient_key), [.bolus, .device])
        XCTAssertNotEqual(body.packages[0].ciphertext, body.packages[1].ciphertext)

        // Ania's phone: listed, saved with Face ID, ready.
        let pkg = body.packages[0]
        let ownerPublic = try XCTUnwrap(ownerKeys.loadKeys()).device as! SoftwareDeviceSigningKey
        api.pending = [handoff(to: aniaPhoneID, recipientKey: .bolus, sender: ownerPublic)]
        api.consumed = ConsumedHandoff(handoff: api.pending[0], ciphertext: pkg.ciphertext, sender_signature: pkg.sender_signature)
        let aniaTrio = InMemoryTrioRemoteSettingsStore()
        let inbox = await RemoteSettingsInboxModel(api: api, keys: InMemoryDeviceKeyStore(keys: DeviceKeyPair(device: SoftwareDeviceSigningKey(), bolus: aniaPhone)),
                                                   deviceID: { self.aniaPhoneID }, trioStore: aniaTrio, loopStore: InMemoryLoopRemoteSettingsStore())
        await inbox.refresh()
        let pending = await inbox.pending(for: patientID)
        XCTAssertEqual(pending.map(\.title), ["Tomek przekazał Ci ustawienia Trio dla: Zosia"])
        let saved = await inbox.save(pending[0])
        XCTAssertTrue(saved)
        XCTAssertEqual(api.consumeCount, 1)
        XCTAssertEqual(try aniaTrio.load(patientID: patientID)?.sharedSecret, "fikcyjny-sekret-zosi")
        XCTAssertEqual(try aniaTrio.load(patientID: patientID)?.maxBolusUnits, 4)
        XCTAssertTrue(try XCTUnwrap(aniaTrio.load(patientID: patientID)).isComplete(glucoMindTeamID: team))
        let left = await inbox.pending
        XCTAssertTrue(left.isEmpty)
    }

    func testOwnerWithoutCompleteSettingsSendsNothing() async {
        let api = FakeHandoffAPI()
        let sender = RemoteSettingsHandoffSender(api: api, keys: InMemoryDeviceKeyStore(keys: DeviceKeyPair(device: SoftwareDeviceSigningKey())), deviceID: { self.ownerDeviceID },
                                                 trioStore: InMemoryTrioRemoteSettingsStore(), loopStore: InMemoryLoopRemoteSettingsStore(), glucoMindTeamID: team, confirm: nil)
        do {
            _ = try await sender.send(patientID: patientID, patientName: "Zosia", fromUserID: "u", fromName: "Tomek", toUserID: "a", toName: "Ania", loopKind: .trio)
            XCTFail("sent")
        } catch {
            XCTAssertEqual(error as? RemoteSettingsHandoffError, .nothingToHandOver)
        }
        XCTAssertNil(api.created)
    }

    func testCancelledFaceIDKeepsTheFetchedPackageForAnotherTry() async throws {
        let api = FakeHandoffAPI()
        let owner = SoftwareDeviceSigningKey()
        let answers = AnswerQueue([.refused("Anulowano."), .confirmed])
        let bolus = SoftwareDeviceSigningKey(confirm: { _ in await answers.next() })
        let sealed = try await RemoteSettingsHandoffCrypto.seal(package(to: aniaPhoneID), for: device(aniaPhoneID, key: bolus), signer: owner)
        api.pending = [handoff(to: aniaPhoneID, recipientKey: .bolus, sender: owner)]
        api.consumed = ConsumedHandoff(handoff: api.pending[0], ciphertext: sealed.ciphertext, sender_signature: sealed.sender_signature)
        let store = InMemoryTrioRemoteSettingsStore()
        let inbox = await RemoteSettingsInboxModel(api: api, keys: InMemoryDeviceKeyStore(keys: DeviceKeyPair(device: SoftwareDeviceSigningKey(), bolus: bolus)),
                                                   deviceID: { self.aniaPhoneID }, trioStore: store, loopStore: InMemoryLoopRemoteSettingsStore())
        await inbox.refresh()
        let first = await inbox.save(api.pending[0])
        XCTAssertFalse(first)
        // Fetched once (single use on the server); after the cancel it is still offered from memory.
        api.pending = []
        await inbox.refresh()
        let offered = await inbox.pending.count
        XCTAssertEqual(offered, 1)
        let second = await inbox.save(handoff(to: aniaPhoneID, recipientKey: .bolus, sender: owner))
        XCTAssertTrue(second)
        XCTAssertEqual(api.consumeCount, 1)
        XCTAssertNotNil(try store.load(patientID: patientID))
    }

    // MARK: Helpers

    private func assertThrows(_ expected: RemoteSettingsHandoffError, file: StaticString = #filePath, line: UInt = #line, _ work: @escaping () async throws -> RemoteSettingsPackage) async {
        do {
            _ = try await work()
            XCTFail("opened", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? RemoteSettingsHandoffError, expected, file: file, line: line)
        }
    }
}

private actor PromptLog {
    private(set) var all: [String] = []
    func add(_ prompt: String) { all.append(prompt) }
}

private actor AnswerQueue {
    private var answers: [BiometricResult]
    init(_ answers: [BiometricResult]) { self.answers = answers }
    func next() -> BiometricResult { answers.isEmpty ? .confirmed : answers.removeFirst() }
}

private final class FakeHandoffAPI: RemoteSettingsHandoffAPI, @unchecked Sendable {
    var devices: [HandoffDevice] = []
    var created: HandoffCreateBody?
    var pending: [RemoteSettingsHandoff] = []
    var consumed: ConsumedHandoff?
    var consumeCount = 0

    func handoffDevices(patientID: String, userID: String) async throws -> HandoffDevicesResponse {
        HandoffDevicesResponse(patient_id: patientID, user_id: userID, display_name: "Ania", devices: devices)
    }

    func createHandoff(patientID: String, body: HandoffCreateBody) async throws -> HandoffCreateResponse {
        created = body
        return HandoffCreateResponse(handoffs: body.packages.map { HandoffCreated(handoff_id: UUID().uuidString, to_device_id: $0.to_device_id, expires_at: "2026-11-05T08:00:00.000Z") })
    }

    func listPatientHandoffs(patientID: String) async throws -> [RemoteSettingsHandoff] { [] }
    func revokeHandoff(patientID: String, handoffID: String) async throws {}
    func listMyHandoffs() async throws -> [RemoteSettingsHandoff] { pending }

    func consumeHandoff(handoffID: String) async throws -> ConsumedHandoff {
        consumeCount += 1
        guard let consumed else { throw APIClientError.notFound(nil) }
        self.consumed = nil
        return consumed
    }

    func rejectHandoff(handoffID: String) async throws {}
}
