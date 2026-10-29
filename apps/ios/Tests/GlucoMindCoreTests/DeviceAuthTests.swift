import CryptoKit
import Security
import XCTest
@testable import GlucoMindCore

/// Device auth (docs/device-auth-api.md): the signed bytes must equal the server's (device-crypto.ts) byte for
/// byte, keys and signatures must be in the formats the server parses, and sessions renew without the person noticing.
final class DeviceAuthMessageTests: XCTestCase {
    func testCodesAreNormalizedLikeTheServer() {
        // device-crypto.spec.ts: normalizeOneTimeCode('ab0-o1-il') === 'AB00111'
        XCTAssertEqual(OneTimeCode.normalize("ab0-o1-il"), "AB00111")
        XCTAssertEqual(OneTimeCode.normalize(" 7kq2m 9xh4t-ABCDE-fghjk "), "7KQ2M9XH4TABCDEFGHJK")
        XCTAssertTrue(OneTimeCode.isPlausible("7KQ2M-9XH4T-ABCDE-FGHJK"))
        XCTAssertFalse(OneTimeCode.isPlausible("short"))
    }

    func testPairingAndSessionMessagesAreTheServersBytes() {
        // device-crypto.spec.ts: pairingMessage('abcde-fghjk', 'K1') === 'mellis-pair-v2\nABCDEFGHJK\nK1'
        XCTAssertEqual(String(decoding: DeviceAuthMessage.pairing(code: "abcde-fghjk", publicKey: "K1"), as: UTF8.self), "mellis-pair-v2\nABCDEFGHJK\nK1")
        // device-crypto.spec.ts: bolusKeyMessage('device-1', 'challenge-1', 'nonce-1', 'B1')
        XCTAssertEqual(String(decoding: DeviceAuthMessage.bolusKey(deviceID: "device-1", challengeID: "challenge-1", nonce: "nonce-1", bolusPublicKey: "B1"), as: UTF8.self), "mellis-bolus-key-v1\ndevice-1\nchallenge-1\nnonce-1\nB1")
        XCTAssertEqual(String(decoding: DeviceAuthMessage.session(deviceID: "device-1", challengeID: "challenge-1", nonce: "nonce-1"), as: UTF8.self), "mellis-session-v1\ndevice-1\nchallenge-1\nnonce-1")
    }

    func testRemoteCommandPayloadIsExactJSON() throws {
        let challenge = SigningChallenge(challenge_id: "c", nonce: "n", expires_at: "2026-10-28T12:02:00.000Z", patient_id: "p", patient_name: "Janek")
        let confirmation = DeviceAuthMessage.remoteCommandConfirmation(patientName: "Janek", insulinU: Decimal(string: "2.5")!, carbsG: 30)
        XCTAssertEqual(confirmation, "Janek: podać 30 g węglowodanów i 2,5 j insuliny?")
        let payload = DeviceAuthMessage.remoteCommand(challenge: challenge, deviceID: "d", insulinU: Decimal(string: "2.5")!, carbsG: 30, confirmation: confirmation)
        XCTAssertEqual(
            String(decoding: payload, as: UTF8.self),
            #"{"v":1,"type":"remote_command","challenge_id":"c","nonce":"n","device_id":"d","patient_id":"p","patient_name":"Janek","insulin_u":2.5,"carbs_g":30,"confirmation":"Janek: podać 30 g węglowodanów i 2,5 j insuliny?"}"#
        )
        // What the server's readSignedPayload checks: v, type, the six strings and two finite numbers.
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(json["v"] as? Int, 1)
        XCTAssertEqual((json["insulin_u"] as? NSNumber)?.doubleValue, 2.5)
        XCTAssertEqual(json["carbs_g"] as? Int, 30)

        let carbsOnly = DeviceAuthMessage.remoteCommand(challenge: challenge, deviceID: "d", insulinU: 0, carbsG: 15, confirmation: "x")
        XCTAssertTrue(String(decoding: carbsOnly, as: UTF8.self).contains(#""insulin_u":0,"carbs_g":15"#))
        let insulinOnly = DeviceAuthMessage.remoteCommandConfirmation(patientName: "Zosia", insulinU: Decimal(string: "0.35")!, carbsG: 0)
        XCTAssertEqual(insulinOnly, "Zosia: podać 0,35 j insuliny?")
    }

    func testStringsAreEscapedAndNeverReordered() {
        let challenge = SigningChallenge(challenge_id: "c/1", nonce: "a\"b", expires_at: "", patient_id: "p", patient_name: "Zoë \\ Ewa")
        let payload = String(decoding: DeviceAuthMessage.remoteBolusConfirm(challenge: challenge, deviceID: "d", confirmation: DeviceAuthMessage.remoteBolusConfirmation(patientName: "Zoë \\ Ewa")), as: UTF8.self)
        XCTAssertEqual(payload, #"{"v":1,"type":"remote_bolus_confirm","challenge_id":"c/1","nonce":"a\"b","device_id":"d","patient_id":"p","patient_name":"Zoë \\ Ewa","confirmation":"Chcę podawać bolus zdalnie dla: Zoë \\ Ewa"}"#)
    }

    func testEnvelopeCarriesBase64URLPayloadAndBase64Signature() {
        let envelope = DeviceAuthorizationEnvelope(signedBytes: Data([0xfb, 0xff, 0xfe]), signature: Data([0xfb, 0xff]))
        XCTAssertEqual(envelope.payload, "-__-")
        XCTAssertEqual(envelope.signature, "+/8=")
    }
}

final class DeviceKeyTests: XCTestCase {
    func testSoftwareKeysExportX963AndSignDERTheWayTheSecureEnclaveDoes() async throws {
        let key = SoftwareDeviceSigningKey()
        XCTAssertEqual(key.publicKeyX963.count, 65)
        XCTAssertEqual(key.publicKeyX963.first, 0x04)
        let message = DeviceAuthMessage.session(deviceID: "d", challengeID: "c", nonce: "n")
        let signature = try await key.sign(message, prompt: nil)
        // The Security framework reads both like the server: the X9.63 point and .ecdsaSignatureMessageX962SHA256 DER.
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass as String: kSecAttrKeyClassPublic]
        let publicKey = try XCTUnwrap(SecKeyCreateWithData(key.publicKeyX963 as CFData, attributes as CFDictionary, nil))
        XCTAssertTrue(SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, message as CFData, signature as CFData, nil))
        XCTAssertFalse(SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, Data("other".utf8) as CFData, signature as CFData, nil))
        // Base64 with padding, 88 characters: what parseP256PublicKey accepts.
        XCTAssertEqual(key.publicKeyBase64.count, 88)
    }

    func testTheBolusKeySignsOnlyAfterConfirmation() async throws {
        let refused = SoftwareDeviceSigningKey(confirm: { _ in .refused("Anulowano.") })
        do {
            _ = try await refused.sign(Data("x".utf8), prompt: "Janek: podać 1 j insuliny?")
            XCTFail("signed without Face ID")
        } catch {
            XCTAssertEqual(error as? DeviceKeyError, .cancelled)
        }
        let prompts = PromptRecorder()
        let confirmed = SoftwareDeviceSigningKey(confirm: { prompt in prompts.add(prompt); return .confirmed })
        _ = try await confirmed.sign(Data("x".utf8), prompt: "Janek: podać 1 j insuliny?")
        XCTAssertEqual(prompts.values, ["Janek: podać 1 j insuliny?"])
    }

    func testPairingMakesOnlyTheDeviceKeyAndTheBolusKeyComesLater() throws {
        let store = InMemoryDeviceKeyStore()
        let first = try store.createKeys()
        XCTAssertNil(first.bolus)
        let bolus = try store.createBolusKey()
        XCTAssertNotEqual(bolus.publicKeyX963, first.device.publicKeyX963)
        XCTAssertEqual(try store.loadKeys()?.bolus?.publicKeyX963, bolus.publicKeyX963)
        // A new pairing replaces every key, the bolus key too.
        let second = try store.createKeys()
        XCTAssertNotEqual(first.device.publicKeyX963, second.device.publicKeyX963)
        XCTAssertNil(try store.loadKeys()?.bolus)
        XCTAssertEqual(try store.loadKeys()?.device.publicKeyX963, second.device.publicKeyX963)
        _ = try store.createBolusKey()
        store.deleteBolusKey()
        XCTAssertNil(try store.loadKeys()?.bolus)
        XCTAssertNotNil(try store.loadKeys()?.device)
        store.deleteKeys()
        XCTAssertNil(try store.loadKeys())
    }

    func testAPhoneWithoutBiometricsGetsNoBolusKey() throws {
        let store = InMemoryDeviceKeyStore(biometricsAvailable: false)
        _ = try store.createKeys()
        XCTAssertThrowsError(try store.createBolusKey()) { error in
            XCTAssertEqual(error as? DeviceKeyError, .biometryNotAvailable)
        }
        XCTAssertNil(try store.loadKeys()?.bolus)
        XCTAssertTrue(DeviceKeyError.biometryNotAvailable.message.contains("Face ID albo Touch ID"))
    }

    func testOneConfirmationSignsSeveralMessages() async throws {
        let prompts = PromptRecorder()
        let key = SoftwareDeviceSigningKey(confirm: { prompt in prompts.add(prompt); return .confirmed })
        let signatures = try await key.sign([Data("a".utf8), Data("b".utf8)], prompt: "Chcę podawać bolus zdalnie dla: Zosia")
        XCTAssertEqual(signatures.count, 2)
        XCTAssertEqual(prompts.values, ["Chcę podawać bolus zdalnie dla: Zosia"])
        let publicKey = try P256.Signing.PublicKey(x963Representation: key.publicKeyX963)
        XCTAssertTrue(publicKey.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: signatures[1]), for: Data("b".utf8)))
    }
}

final class PairingLinkTests: XCTestCase {
    func testReadsTheServersPairingURL() throws {
        // URLSearchParams in pairingView: the server address is percent-encoded.
        let link = try PairingLink.parse("mellis://pair?server=https%3A%2F%2Fmellis.example&code=7KQ2M-9XH4T-ABCDE-FGHJK", allowsInsecureHTTP: false).get()
        XCTAssertEqual(link.serverURL.absoluteString, "https://mellis.example")
        XCTAssertEqual(link.code, "7KQ2M-9XH4T-ABCDE-FGHJK")
        let url = try XCTUnwrap(URL(string: "MELLIS://pair?server=https://mellis.example/api/&code=7kq2m9xh4tabcdefghjk"))
        XCTAssertEqual(try PairingLink.parse(url, allowsInsecureHTTP: false).get().serverURL.absoluteString, "https://mellis.example/api")
    }

    func testFindsTheLinkInAPastedMessage() throws {
        let message = "Zaproszenie do Mellisa:\nmellis://pair?server=https%3A%2F%2Fmellis.example&code=7KQ2M-9XH4T-ABCDE-FGHJK\nWażne 7 dni."
        XCTAssertEqual(try PairingLink.parse(message, allowsInsecureHTTP: false).get().code, "7KQ2M-9XH4T-ABCDE-FGHJK")
    }

    func testRefusesWhatIsNotAMellisLink() {
        XCTAssertEqual(PairingLink.parse("https://mellis.example", allowsInsecureHTTP: false), .failure(.notALink))
        XCTAssertEqual(PairingLink.parse("mellis://other?server=https://a.b&code=7KQ2M-9XH4T-ABCDE-FGHJK", allowsInsecureHTTP: false), .failure(.notALink))
        XCTAssertEqual(PairingLink.parse("mellis://pair?code=7KQ2M-9XH4T-ABCDE-FGHJK", allowsInsecureHTTP: false), .failure(.missingServer))
        XCTAssertEqual(PairingLink.parse("mellis://pair?server=https://a.b&code=ABC", allowsInsecureHTTP: false), .failure(.missingCode))
        XCTAssertEqual(PairingLink.parse("mellis://pair?server=ftp://a.b&code=7KQ2M-9XH4T-ABCDE-FGHJK", allowsInsecureHTTP: true), .failure(.missingServer))
    }

    func testPlainHTTPOnlyInDevelopment() throws {
        let text = "mellis://pair?server=http%3A%2F%2Flocalhost%3A3000&code=7KQ2M-9XH4T-ABCDE-FGHJK"
        XCTAssertEqual(PairingLink.parse(text, allowsInsecureHTTP: false), .failure(.insecureServer))
        XCTAssertEqual(try PairingLink.parse(text, allowsInsecureHTTP: true).get().serverURL.absoluteString, "http://localhost:3000")
    }

    func testATypedServerAddressGetsHTTPS() throws {
        XCTAssertEqual(try PairingLink.serverURL(" mellis.example/ ", allowsInsecureHTTP: false).get().absoluteString, "https://mellis.example")
        let link = PairingLink(serverURL: URL(string: "https://mellis.example")!, code: "x")
        XCTAssertTrue(link.isSameServer(as: URL(string: "https://MELLIS.example:443")!))
        XCTAssertFalse(link.isSameServer(as: URL(string: "https://other.example")!))
    }
}

final class KeychainDevicePairingStoreTests: XCTestCase {
    func testPairingAndSessionRoundTripInTheKeychain() throws {
        let item = KeychainDataItem(service: "pl.mellis.tests.\(UUID().uuidString)", account: "probe", accessGroup: nil)
        do {
            try item.save(Data("probe".utf8))
        } catch let error as KeychainItemError where error.status == errSecMissingEntitlement || error.status == errSecInteractionNotAllowed || error.status == errSecNotAvailable {
            throw XCTSkip("No Keychain in this test host (\(error.status)).")
        }
        XCTAssertEqual(try item.load(), Data("probe".utf8))
        try item.save(Data("again".utf8))
        XCTAssertEqual(try item.load(), Data("again".utf8))
        try item.delete()
        XCTAssertNil(try item.load())

        let store = KeychainDevicePairingStore(accessGroup: nil)
        store.clear()
        let pairing = DevicePairing(serverURL: URL(string: "https://mellis.example")!, deviceID: "d1", userID: "u1", displayName: "Ewa", pairedAt: Date(timeIntervalSince1970: 1_800_000_000))
        try store.savePairing(pairing)
        try store.saveSession(DeviceSessionToken(accessToken: "mls_x", expiresAt: Date(timeIntervalSince1970: 1_800_000_900)))
        XCTAssertEqual(try store.loadPairing(), pairing)
        XCTAssertEqual(try store.loadSession()?.accessToken, "mls_x")
        store.clearSession()
        XCTAssertNil(try store.loadSession())
        XCTAssertEqual(try store.loadPairing(), pairing)
        store.clear()
        XCTAssertNil(try store.loadPairing())
    }
}

final class DeviceAuthProviderTests: XCTestCase {
    private let server = URL(string: "https://mellis.example")!
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    private func pairedProvider(transport: FakeDeviceAuthTransport, clock: MutableClock, session: DeviceSessionToken? = nil) throws -> (DeviceAuthProvider, InMemoryDevicePairingStore, InMemoryDeviceKeyStore) {
        let keys = InMemoryDeviceKeyStore()
        let pair = try keys.createKeys()
        transport.deviceKey = pair.device
        let store = InMemoryDevicePairingStore(pairing: DevicePairing(serverURL: server, deviceID: "device-1", userID: "u1", displayName: "Ewa", pairedAt: start), session: session)
        return (DeviceAuthProvider(store: store, keys: keys, transport: transport, clock: clock), store, keys)
    }

    func testPairingSignsWithTheDeviceKeyOnlyAndStoresServerDeviceAndSession() async throws {
        let transport = FakeDeviceAuthTransport(now: start)
        let keys = InMemoryDeviceKeyStore()
        let store = InMemoryDevicePairingStore()
        let provider = DeviceAuthProvider(store: store, keys: keys, transport: transport, clock: MutableClock(now: start))
        let link = PairingLink(serverURL: server, code: "7kq2m-9xh4t-abcde-fghjk")
        let response = try await provider.pair(link: link, deviceName: "iPhone Ewy", clientDeviceID: "push-id")

        XCTAssertEqual(response.device_id, "device-1")
        let body = try XCTUnwrap(transport.pairBodies.first)
        XCTAssertEqual(body.device.client_device_id, "push-id")
        let pair = try XCTUnwrap(try keys.loadKeys())
        XCTAssertEqual(body.device.public_key, pair.device.publicKeyBase64)
        // No bolus key and no Face ID at pairing: a phone without biometrics pairs too.
        XCTAssertNil(pair.bolus)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertNil(json["bolus_signature"])
        XCTAssertNil((json["device"] as? [String: Any])?["bolus_public_key"])
        let message = DeviceAuthMessage.pairing(code: link.code, publicKey: body.device.public_key)
        XCTAssertTrue(verify(body.signature, message: message, key: pair.device))
        XCTAssertEqual(try store.loadPairing()?.serverURL, server)
        XCTAssertEqual(try store.loadPairing()?.deviceID, "device-1")
        // The pairing's first session is used at once: no challenge needed.
        let token = try await provider.bearerToken()
        XCTAssertEqual(token, "mls_paired")
        XCTAssertEqual(transport.challenges, 0)
    }

    func testRenewsOneMinuteBeforeExpiryWithTheDeviceKey() async throws {
        let transport = FakeDeviceAuthTransport(now: start)
        let clock = MutableClock(now: start)
        let (provider, store, _) = try pairedProvider(transport: transport, clock: clock, session: DeviceSessionToken(accessToken: "mls_old", expiresAt: start.addingTimeInterval(15 * 60)))

        let first = try await provider.bearerToken()
        XCTAssertEqual(first, "mls_old")
        clock.now = start.addingTimeInterval(13 * 60 + 59)
        let stillOld = try await provider.bearerToken()
        XCTAssertEqual(stillOld, "mls_old")
        XCTAssertEqual(transport.challenges, 0)
        clock.now = start.addingTimeInterval(14 * 60 + 1)
        let renewed = try await provider.bearerToken()
        XCTAssertEqual(renewed, "mls_1")
        XCTAssertEqual(transport.challenges, 1)
        XCTAssertEqual(transport.validSignatures, 1)
        XCTAssertEqual(try store.loadSession()?.accessToken, "mls_1")
    }

    func testConcurrentRequestsShareOneRenewal() async throws {
        let transport = FakeDeviceAuthTransport(now: start)
        transport.delayNanoseconds = 50_000_000
        let (provider, _, _) = try pairedProvider(transport: transport, clock: MutableClock(now: start))
        async let a = provider.bearerToken()
        async let b = provider.bearerToken()
        async let c = provider.bearerToken()
        let tokens = try await [a, b, c]
        XCTAssertEqual(Set(tokens), ["mls_1"])
        XCTAssertEqual(transport.challenges, 1)
    }

    func testAnUnpairedDeviceEndsThePairing() async throws {
        let transport = FakeDeviceAuthTransport(now: start)
        transport.challengeError = APIClientError.unauthenticated(ProblemDetails(type: "about:blank", title: "This device is not paired with the server", status: 401, code: "DEVICE_NOT_PAIRED", instance: nil))
        let (provider, store, keys) = try pairedProvider(transport: transport, clock: MutableClock(now: start))
        let ended = expectation(description: "session ended")
        await provider.setSessionEndedHandler { ended.fulfill() }

        let restored = await provider.restoreSession()
        XCTAssertFalse(restored)
        await fulfillment(of: [ended], timeout: 1)
        XCTAssertNil(try store.loadPairing())
        XCTAssertNil(try keys.loadKeys())
    }

    func testBeingOfflineKeepsThePairing() async throws {
        let transport = FakeDeviceAuthTransport(now: start)
        transport.challengeError = APIClientError.transport("offline")
        let (provider, store, _) = try pairedProvider(transport: transport, clock: MutableClock(now: start))
        let restored = await provider.restoreSession()
        XCTAssertTrue(restored)
        XCTAssertNotNil(try store.loadPairing())
        do {
            _ = try await provider.bearerToken()
            XCTFail("token without a server")
        } catch {
            XCTAssertEqual(error as? APIClientError, .transport("offline"))
        }
    }

    func testARefusedTokenRenewsAndTheRequestIsRetriedOnce() async throws {
        let transport = FakeDeviceAuthTransport(now: start)
        let (provider, _, _) = try pairedProvider(transport: transport, clock: MutableClock(now: start), session: DeviceSessionToken(accessToken: "mls_dropped", expiresAt: start.addingTimeInterval(900)))
        let http = StatusHTTPClient(refusedToken: "mls_dropped")
        let client = APIClient(baseURL: server, authProvider: provider, httpClient: DeviceSessionHTTPClient(base: http, provider: provider))
        _ = try await client.listOwnDevices()
        XCTAssertEqual(http.authorizations, ["Bearer mls_dropped", "Bearer mls_1"])
        XCTAssertEqual(transport.challenges, 1)
    }

    func testAnotherRefusedSignatureIsTriedWithANewChallenge() async throws {
        let transport = FakeDeviceAuthTransport(now: start)
        transport.refuseFirstSessions = 1
        let (provider, store, _) = try pairedProvider(transport: transport, clock: MutableClock(now: start))
        let token = try await provider.bearerToken()
        XCTAssertEqual(token, "mls_2")
        XCTAssertEqual(transport.challenges, 2)
        XCTAssertNotNil(try store.loadPairing())
    }
}

/// A base64 DER signature by `key` over `message`, checked like the server's verifyDeviceSignature.
func verify(_ signature: String, message: Data, key: DeviceSigningKey) -> Bool {
    guard let der = Data(base64Encoded: signature),
          let ecdsa = try? P256.Signing.ECDSASignature(derRepresentation: der),
          let publicKey = try? P256.Signing.PublicKey(x963Representation: key.publicKeyX963) else { return false }
    return publicKey.isValidSignature(ecdsa, for: message)
}

final class DeviceRemoteCommandSignerTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeSigner(api: FakeSigningAPI, keys: InMemoryDeviceKeyStore) -> DeviceRemoteCommandSigner {
        DeviceRemoteCommandSigner(api: api, deviceID: { "device-1" }, keys: keys, now: { self.now })
    }

    func testSignsTheExactAmountsForThePatientTheServerNames() async throws {
        let prompts = PromptRecorder()
        let keys = InMemoryDeviceKeyStore(confirm: { prompt in prompts.add(prompt); return .confirmed })
        let device = try keys.createKeys().device
        let bolus = try keys.createBolusKey()
        let api = FakeSigningAPI(now: now)
        let signed = try await makeSigner(api: api, keys: keys).signRemoteCommand(patientID: "p1", insulinU: Decimal(string: "2.5")!, carbsG: 30)

        XCTAssertEqual(signed.confirmation, "Janek: podać 30 g węglowodanów i 2,5 j insuliny?")
        XCTAssertEqual(prompts.values, [signed.confirmation])
        XCTAssertEqual(api.purposes, [.remoteBolus])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: signed.payload) as? [String: Any])
        XCTAssertEqual(json["challenge_id"] as? String, "ch-1")
        XCTAssertEqual(json["device_id"] as? String, "device-1")
        XCTAssertEqual(json["patient_name"] as? String, "Janek")
        // The envelope carries exactly the signed bytes.
        let padded = signed.authorization.payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let bytes = try XCTUnwrap(Data(base64Encoded: padded + String(repeating: "=", count: (4 - padded.count % 4) % 4)))
        XCTAssertEqual(bytes, signed.payload)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: try XCTUnwrap(Data(base64Encoded: signed.authorization.signature)))
        XCTAssertTrue(try P256.Signing.PublicKey(x963Representation: bolus.publicKeyX963).isValidSignature(signature, for: bytes))
        XCTAssertFalse(try P256.Signing.PublicKey(x963Representation: device.publicKeyX963).isValidSignature(signature, for: bytes))
    }

    func testAPrefetchedChallengeIsUsedOnceAndOnlyWhileFresh() async throws {
        let keys = InMemoryDeviceKeyStore()
        _ = try keys.createKeys()
        _ = try keys.createBolusKey()
        let api = FakeSigningAPI(now: now)
        let signer = makeSigner(api: api, keys: keys)
        await signer.prepare(patientID: "p1")
        let first = try await signer.signRemoteCommand(patientID: "p1", insulinU: 1, carbsG: 0)
        XCTAssertTrue(String(decoding: first.payload, as: UTF8.self).contains(#""challenge_id":"ch-1""#))
        // Used up (a 409 REMOTE_COMMAND_WARNINGS_CHANGED burns it too): the next signature asks for a new one.
        let second = try await signer.signRemoteCommand(patientID: "p1", insulinU: 1, carbsG: 0)
        XCTAssertTrue(String(decoding: second.payload, as: UTF8.self).contains(#""challenge_id":"ch-2""#))

        api.validity = 20
        await signer.prepare(patientID: "p1")
        let third = try await signer.signRemoteCommand(patientID: "p1", insulinU: 1, carbsG: 0)
        XCTAssertTrue(String(decoding: third.payload, as: UTF8.self).contains(#""challenge_id":"ch-4""#))
        XCTAssertEqual(api.purposes.count, 4)
    }

    func testCancelledFaceIDSignsNothing() async throws {
        let keys = InMemoryDeviceKeyStore(confirm: { _ in .refused("Anulowano.") })
        _ = try keys.createKeys()
        _ = try keys.createBolusKey()
        do {
            _ = try await makeSigner(api: FakeSigningAPI(now: now), keys: keys).signRemoteCommand(patientID: "p1", insulinU: 1, carbsG: 0)
            XCTFail("signed")
        } catch {
            XCTAssertEqual(error as? RemoteCommandSigningError, .key(.cancelled))
            XCTAssertEqual((error as? RemoteCommandSigningError)?.message, "Anulowano.")
        }
    }

    func testWithoutKeysThePhoneIsNotPaired() async {
        do {
            _ = try await makeSigner(api: FakeSigningAPI(now: now), keys: InMemoryDeviceKeyStore()).signRemoteBolusConfirm(patientID: "p1")
            XCTFail("signed")
        } catch {
            XCTAssertEqual(error as? RemoteCommandSigningError, .notPaired)
        }
    }

    func testTheGranteeConfirmationNamesThePatient() async throws {
        let keys = InMemoryDeviceKeyStore()
        _ = try keys.createKeys()
        let api = FakeSigningAPI(now: now)
        let signed = try await makeSigner(api: api, keys: keys).signRemoteBolusConfirm(patientID: "p1")
        XCTAssertEqual(signed.confirmation, "Chcę podawać bolus zdalnie dla: Janek")
        XCTAssertEqual(api.purposes, [.remoteBolusConfirm])
        XCTAssertTrue(String(decoding: signed.payload, as: UTF8.self).hasPrefix(#"{"v":1,"type":"remote_bolus_confirm","challenge_id":"ch-1""#))
    }

    func testTheConfirmationCreatesAndRegistersTheBolusKeyUnderOneFaceID() async throws {
        let prompts = PromptRecorder()
        let keys = InMemoryDeviceKeyStore(confirm: { prompt in prompts.add(prompt); return .confirmed })
        let device = try keys.createKeys().device
        let api = FakeSigningAPI(now: now)
        let signed = try await makeSigner(api: api, keys: keys).signRemoteBolusConfirm(patientID: "p1")

        let bolus = try XCTUnwrap(try keys.loadKeys()?.bolus)
        XCTAssertEqual(keys.bolusKeysCreated, 1)
        XCTAssertEqual(prompts.values, ["Chcę podawać bolus zdalnie dla: Janek"])
        // Registered with both signatures over the server's bytes (what device-auth.service.ts checks).
        let body = try XCTUnwrap(api.registrations.first)
        XCTAssertEqual(body.bolus_public_key, bolus.publicKeyBase64)
        let message = DeviceAuthMessage.bolusKey(deviceID: "device-1", challengeID: body.challenge_id, nonce: "key-nonce-1", bolusPublicKey: bolus.publicKeyBase64)
        XCTAssertTrue(verify(body.signature, message: message, key: device))
        XCTAssertTrue(verify(body.bolus_signature, message: message, key: bolus))
        // The confirmation itself is signed by the new bolus key.
        XCTAssertTrue(verify(signed.authorization.signature, message: signed.payload, key: bolus))

        // Confirming again (another patient) reuses the key and registers it again.
        _ = try await makeSigner(api: api, keys: keys).signRemoteBolusConfirm(patientID: "p2")
        XCTAssertEqual(keys.bolusKeysCreated, 1)
        XCTAssertEqual(api.registrations.count, 2)
    }

    func testWithoutBiometricsTheConfirmationSaysWhyAndRegistersNothing() async throws {
        let keys = InMemoryDeviceKeyStore(biometricsAvailable: false)
        _ = try keys.createKeys()
        let api = FakeSigningAPI(now: now)
        do {
            _ = try await makeSigner(api: api, keys: keys).signRemoteBolusConfirm(patientID: "p1")
            XCTFail("signed")
        } catch {
            XCTAssertEqual(error as? RemoteCommandSigningError, .key(.biometryNotAvailable))
            XCTAssertEqual((error as? RemoteCommandSigningError)?.message, DeviceBiometrics.unavailableMessage)
        }
        XCTAssertTrue(api.registrations.isEmpty)
        XCTAssertTrue(api.purposes.isEmpty)
    }

    func testARemoteCommandWithoutABolusKeyAsksToSetItUp() async throws {
        let keys = InMemoryDeviceKeyStore()
        _ = try keys.createKeys()
        let api = FakeSigningAPI(now: now)
        do {
            _ = try await makeSigner(api: api, keys: keys).signRemoteCommand(patientID: "p1", insulinU: 1, carbsG: 0)
            XCTFail("signed")
        } catch {
            XCTAssertEqual(error as? RemoteCommandSigningError, .bolusKeyMissing)
        }
        XCTAssertTrue(api.purposes.isEmpty)
        // The server has no key for this phone (registered elsewhere, or the registration was lost).
        _ = try keys.createBolusKey()
        api.challengeError = APIClientError.forbidden(ProblemDetails(type: "about:blank", title: "x", status: 403, code: "BOLUS_KEY_REQUIRED", instance: nil))
        do {
            _ = try await makeSigner(api: api, keys: keys).signRemoteCommand(patientID: "p1", insulinU: 1, carbsG: 0)
            XCTFail("signed")
        } catch {
            XCTAssertEqual(error as? RemoteCommandSigningError, .bolusKeyMissing)
            XCTAssertTrue((error as? RemoteCommandSigningError)?.message.contains("Zdalny bolus → Ustaw na tym telefonie") == true)
        }
    }
}

// MARK: - Fakes

final class PromptRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []
    var values: [String] { lock.withLock { stored } }
    func add(_ value: String) { lock.withLock { stored.append(value) } }
}

final class MutableClock: Clock, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(now: Date) { value = now }
    var now: Date {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// The server's public routes, checking the device key's signatures like device-auth.service.ts.
final class FakeDeviceAuthTransport: DeviceAuthTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let start: Date
    var deviceKey: DeviceSigningKey?
    var challengeError: Error?
    var refuseFirstSessions = 0
    var delayNanoseconds: UInt64 = 0
    private(set) var pairBodies: [PairRequestBody] = []
    private(set) var challenges = 0
    private(set) var validSignatures = 0
    private var nonces: [String: String] = [:]
    private var sessions = 0

    init(now: Date) { start = now }

    func pair(server: URL, body: PairRequestBody) async throws -> PairResponse {
        lock.withLock { pairBodies.append(body) }
        return PairResponse(device_id: "device-1", user: PairedUser(user_id: "u1", display_name: "Ewa"), patients: [], session: DeviceSessionView(access_token: "mls_paired", expires_at: ISO8601DateFormatter().string(from: start.addingTimeInterval(900))), recovery_code: nil)
    }

    func recover(server: URL, body: RecoverRequestBody) async throws -> PairResponse {
        throw APIClientError.invalidResponse
    }

    func sessionChallenge(server: URL, deviceID: String) async throws -> SessionChallenge {
        if delayNanoseconds > 0 { try await Task.sleep(nanoseconds: delayNanoseconds) }
        if let challengeError { throw challengeError }
        return lock.withLock {
            challenges += 1
            let id = "ch-\(challenges)"
            nonces[id] = "nonce-\(challenges)"
            return SessionChallenge(challenge_id: id, nonce: "nonce-\(challenges)", expires_at: "")
        }
    }

    func createSession(server: URL, deviceID: String, challengeID: String, signature: String) async throws -> DeviceSessionView {
        let (nonce, refuse): (String?, Bool) = lock.withLock {
            let refuse = refuseFirstSessions > 0
            if refuse { refuseFirstSessions -= 1 }
            return (nonces.removeValue(forKey: challengeID), refuse)
        }
        let failed = APIClientError.unauthenticated(ProblemDetails(type: "about:blank", title: "x", status: 401, code: "DEVICE_AUTH_FAILED", instance: nil))
        guard !refuse, let nonce, let key = deviceKey,
              let der = Data(base64Encoded: signature),
              let ecdsa = try? P256.Signing.ECDSASignature(derRepresentation: der),
              let publicKey = try? P256.Signing.PublicKey(x963Representation: key.publicKeyX963),
              publicKey.isValidSignature(ecdsa, for: DeviceAuthMessage.session(deviceID: deviceID, challengeID: challengeID, nonce: nonce)) else {
            throw failed
        }
        let number: Int = lock.withLock {
            validSignatures += 1
            sessions += 1
            return challenges
        }
        return DeviceSessionView(access_token: "mls_\(number)", expires_at: ISO8601DateFormatter().string(from: start.addingTimeInterval(3600)))
    }
}

final class StatusHTTPClient: HTTPClient, @unchecked Sendable {
    let refusedToken: String
    private(set) var authorizations: [String] = []

    init(refusedToken: String) { self.refusedToken = refusedToken }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let header = request.value(forHTTPHeaderField: "Authorization") ?? ""
        authorizations.append(header)
        let refused = header == "Bearer \(refusedToken)"
        let body = refused ? Data(#"{"type":"about:blank","title":"Unauthorized","status":401,"code":"UNAUTHENTICATED"}"#.utf8) : Data(#"{"devices":[]}"#.utf8)
        return (body, HTTPURLResponse(url: request.url!, statusCode: refused ? 401 : 200, httpVersion: nil, headerFields: nil)!)
    }
}

final class FakeSigningAPI: SigningChallengeAPI, @unchecked Sendable {
    private let now: Date
    var validity: TimeInterval = 120
    var challengeError: Error?
    private(set) var purposes: [SigningPurpose] = []
    private(set) var registrations: [BolusKeyRegisterBody] = []
    private var keyChallenges = 0

    init(now: Date) { self.now = now }

    func createBolusKeyChallenge() async throws -> SessionChallenge {
        keyChallenges += 1
        return SessionChallenge(challenge_id: "key-ch-\(keyChallenges)", nonce: "key-nonce-\(keyChallenges)", expires_at: "")
    }

    func registerBolusKey(_ body: BolusKeyRegisterBody) async throws -> BolusKeyRegistration {
        registrations.append(body)
        return BolusKeyRegistration(device_id: "device-1", bolus_key_registered_at: "2026-10-29T08:00:00.000Z")
    }

    func createSigningChallenge(patientID: String, purpose: SigningPurpose) async throws -> SigningChallenge {
        if let challengeError { throw challengeError }
        purposes.append(purpose)
        let number = purposes.count
        return SigningChallenge(challenge_id: "ch-\(number)", nonce: "n-\(number)", expires_at: ISO8601DateFormatter().string(from: now.addingTimeInterval(validity)), patient_id: patientID, patient_name: "Janek")
    }
}

@MainActor
final class DeviceSharingViewModelTests: XCTestCase {
    private func person(remote: RemoteBolusGrant) -> PatientPerson {
        PatientPerson(user_id: "u2", display_name: "Ewa", is_owner: false, permissions: SharingPermissions(glucose_alerts: true, ai_chat_meals: true, manage_sharing: false, remote_commands: remote.effective), remote_bolus: remote, is_you: false, devices: [])
    }

    func testOnlyChangedSwitchesAreSentSoAConfirmedGrantStays() async {
        let api = FakeSharingAPI()
        let model = DeviceSharingViewModel(patientID: "p1", patientName: "Janek", api: api, signer: nil)
        let confirmed = person(remote: RemoteBolusGrant(granted_by: "u1", granted_at: "2026-10-28T10:00:00Z", confirmed_at: "2026-10-28T10:01:00Z", effective: true))
        var edited = confirmed.editablePermissions
        XCTAssertTrue(edited.remote_commands)
        edited.glucose_alerts = false
        _ = await model.update(confirmed, to: edited)
        XCTAssertEqual(api.changes, [["glucose_alerts": false]])

        // Awaiting confirmation counts as on: switching it off is the only change.
        let awaiting = person(remote: RemoteBolusGrant(granted_by: "u1", granted_at: "2026-10-28T10:00:00Z"))
        XCTAssertEqual(awaiting.remote_bolus.state, .awaitingConfirmation)
        var off = awaiting.editablePermissions
        off.remote_commands = false
        _ = await model.update(awaiting, to: off)
        XCTAssertEqual(api.changes.last, ["remote_commands": false])
    }

    func testTheGranteeConfirmsWithTheSignedPayload() async throws {
        let api = FakeSharingAPI()
        let keys = InMemoryDeviceKeyStore()
        _ = try keys.createKeys()
        _ = try keys.createBolusKey()
        let signer = DeviceRemoteCommandSigner(api: FakeSigningAPI(now: Date()), deviceID: { "d1" }, keys: keys)
        let model = DeviceSharingViewModel(patientID: "p1", patientName: "Janek", api: api, signer: signer)
        let confirmed = await model.confirmRemoteBolus()
        XCTAssertTrue(confirmed)
        XCTAssertNotNil(api.confirmation)
        XCTAssertNotNil(model.notice)
    }

    func testSoftwareKeyShowsWhyFaceIDCouldNotRun() async {
        let key = SoftwareDeviceSigningKey(confirm: { _ in .refused("Face ID nie jest skonfigurowany.") })
        do {
            _ = try await key.sign(Data(), prompt: nil)
            XCTFail("signed")
        } catch {
            XCTAssertEqual(error as? DeviceKeyError, .failed("Face ID nie jest skonfigurowany."))
        }
    }
}

final class FakeSharingAPI: DeviceSharingAPI, @unchecked Sendable {
    private(set) var changes: [[String: Bool]] = []
    private(set) var confirmation: DeviceAuthorizationEnvelope?
    private(set) var createdPatients: [NewPatientBody] = []
    var coOwners: [CoOwnerCandidate] = []

    func listOwnDevices() async throws -> [PairedDevice] { [] }
    func revokeOwnDevice(deviceID: String) async throws {}
    func createOwnPairingCode() async throws -> PairingCode { PairingCode(code: "c", expires_at: "", pairing_url: "mellis://pair") }
    func acceptInvitation(code: String) async throws -> InvitationAcceptResponse { InvitationAcceptResponse(patient_id: "p2", member: nil) }
    func listPeople(patientID: String) async throws -> PatientPeopleResponse {
        PatientPeopleResponse(patient_id: patientID, you_are_owner: true, people: [], invitations: [])
    }
    func createInvitation(patientID: String, firstName: String, permissions: SharingPermissions) async throws -> InvitationCreateResponse { throw APIClientError.invalidResponse }
    func revokeInvitation(patientID: String, invitationID: String) async throws {}
    func updatePerson(patientID: String, userID: String, changes: [String: Bool]) async throws -> PatientPerson {
        self.changes.append(changes)
        throw APIClientError.invalidResponse
    }
    func removePerson(patientID: String, userID: String) async throws {}
    func revokeMemberDevice(patientID: String, userID: String, deviceID: String) async throws {}
    func confirmRemoteBolus(patientID: String, authorization: DeviceAuthorizationEnvelope) async throws -> PatientPerson {
        confirmation = authorization
        return PatientPerson(user_id: "u1", display_name: "Ewa", is_owner: false, permissions: SharingPermissions(), remote_bolus: RemoteBolusGrant(effective: true), is_you: true, devices: nil)
    }
    func createPatient(_ body: NewPatientBody) async throws -> NewPatientResponse {
        createdPatients.append(body)
        return NewPatientResponse(patient: .init(patient_id: "p-new", display_name: body.display_name, birth_year: body.birth_year))
    }
    func listCoOwnerCandidates() async throws -> [CoOwnerCandidate] { coOwners }
    func nightscoutSummary(patientID: String) async throws -> NightscoutSummary { NightscoutSummary(patient_id: patientID, base_url: "https://zosia.ns.example", last_reading_at: nil) }
}

@MainActor
final class AddPatientViewModelTests: XCTestCase {
    func testOwnersOfOtherPatientsArePreselectedAsCoOwnersAndCanBeLeftOut() async throws {
        let api = FakeSharingAPI()
        api.coOwners = [
            CoOwnerCandidate(user_id: "u-ania", display_name: "Ania", patients: [.init(patient_id: "p1", display_name: "Zosia")]),
            CoOwnerCandidate(user_id: "u-tomek", display_name: "Tomek", patients: [.init(patient_id: "p1", display_name: "Zosia"), .init(patient_id: "p2", display_name: "Kuba")]),
        ]
        let model = AddPatientViewModel(api: api, now: Date(timeIntervalSince1970: 1_800_000_000))
        await model.loadCoOwners()
        XCTAssertEqual(model.coOwnerCandidates.map(\.display_name), ["Ania", "Tomek"])
        XCTAssertEqual(model.selectedCoOwnerIDs, ["u-ania", "u-tomek"])
        XCTAssertEqual(api.coOwners[1].detail, "Współwłaściciel: Zosia, Kuba")
        model.toggleCoOwner("u-ania")
        model.displayName = "Kuba"
        model.birthYear = 2018
        model.nightscoutURL = "kuba.ns.example"
        model.token = "reader-1"
        let created = await model.save()
        XCTAssertEqual(created, "p-new")
        XCTAssertEqual(api.createdPatients.first?.co_owner_user_ids, ["u-tomek"])
        XCTAssertEqual(api.createdPatients.first?.nightscout.url, "https://kuba.ns.example")
    }

    func testNoCoOwnersSendsNoField() async throws {
        let api = FakeSharingAPI()
        let model = AddPatientViewModel(api: api)
        await model.loadCoOwners()
        XCTAssertTrue(model.coOwnerCandidates.isEmpty)
        model.displayName = "Zosia"
        model.birthYear = 2019
        model.nightscoutURL = "https://zosia.ns.example"
        model.token = "reader-1"
        _ = await model.save()
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(try XCTUnwrap(api.createdPatients.first))) as? [String: Any])
        XCTAssertNil(json["co_owner_user_ids"])
    }
}
