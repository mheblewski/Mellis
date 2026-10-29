import CryptoKit
import XCTest
@testable import GlucoMindCore

/// Nothing here sends anything: requests are built and inspected only.
final class TrioRemoteCommandTests: XCTestCase {
    /// A throwaway P-256 key generated for these tests (not an Apple key).
    private let testP8 = """
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5kpsG6l2lB3pXegW
TOEyzMynfZFbKhNZTvtLTc6ncRqhRANCAATSjMU+b9Vk63O+VHbF24kH2SHnToGl
e+wzF+Enyzzw2H9lpubtBRWyT0oYcYym3TOR4XxAKiz2ZGjOnS2Sv+gi
-----END PRIVATE KEY-----
"""

    private let target = TrioRemoteTarget(
        status: "READY",
        device_token: String(repeating: "ab", count: 32),
        bundle_id: "org.nightscout.ABCDE12345.trio",
        team_id: "ABCDE12345",
        apns_environment: "production",
        profile_uploaded_at: nil,
        remote_commands: nil,
        build_expires_at: nil
    )

    private func mealPayload() -> TrioCommandPayload {
        TrioCommandPayload(user: "GlucoMind: Ania", commandType: .meal, timestamp: 1_760_860_800, bolusAmount: Decimal(string: "4.55"), carbs: 46, commandId: "c1", returnNotification: nil)
    }

    func testEncryptsExactlyLikeAStandardAESGCMSender() throws {
        // Vector computed with Node's aes-256-gcm (key SHA-256("trio-secret"), nonce 00…0b), the scheme Trio decrypts.
        let messenger = try TrioSecureMessenger(sharedSecret: "trio-secret")
        let nonce = try AES.GCM.Nonce(data: Data((0..<12).map { UInt8($0) }))
        let encrypted = try messenger.encrypt(mealPayload(), nonce: nonce)
        XCTAssertEqual(encrypted, "AAECAwQFBgcICQoLrma1pGgQDjsNpJ4nU6zebrFSX6SJ6YgjPMtIT56lsfNsgbW4k2GvHDfNXDC62U7UwSJvDywRBkK8fbWpKGDxgmFPGJwB8xvOU/dJd7GOKJto6Ns5h1JtGOFOBay2TBkjTHpDewI2PakQsrZUryAtnKvWqEhnvM60DtnbUnjXENC4ywA1RCRzRw==")
    }

    func testTrioReadsTheKeysItExpects() throws {
        let messenger = try TrioSecureMessenger(sharedSecret: "trio-secret")
        var payload = mealPayload()
        payload.returnNotification = TrioReturnNotification(productionEnvironment: false, deviceToken: "cd", bundleId: "pl.glucomind.ios", teamId: "TEAM123456", keyId: "KEY1234567", apnsKey: "pem")
        let json = try JSONSerialization.jsonObject(with: try messenger.decrypt(try messenger.encrypt(payload))) as? [String: Any]
        XCTAssertEqual(json?["command_type"] as? String, "meal")
        XCTAssertEqual(json?["carbs"] as? Int, 46)
        XCTAssertEqual((json?["bolus_amount"] as? NSNumber)?.decimalValue, Decimal(string: "4.55"))
        XCTAssertEqual(json?["timestamp"] as? Double, 1_760_860_800)
        // Carbs now: no date, Trio uses its own clock.
        XCTAssertNil(json?["scheduled_time"])
        payload.scheduledTime = 1_760_861_700
        let later = try JSONSerialization.jsonObject(with: try messenger.decrypt(try messenger.encrypt(payload))) as? [String: Any]
        XCTAssertEqual(later?["scheduled_time"] as? Double, 1_760_861_700)
        let back = json?["return_notification"] as? [String: Any]
        XCTAssertEqual(back?["production_environment"] as? Bool, false)
        XCTAssertEqual(back?["bundle_id"] as? String, "pl.glucomind.ios")
        XCTAssertEqual(Set(back?.keys.map { $0 } ?? []), ["production_environment", "device_token", "bundle_id", "team_id", "key_id", "apns_key"])
        // A wrong secret cannot read it (Trio rejects it as a decryption failure).
        XCTAssertThrowsError(try TrioSecureMessenger(sharedSecret: "other").decrypt(try messenger.encrypt(payload)))
        XCTAssertThrowsError(try TrioSecureMessenger(sharedSecret: ""))
    }

    func testAPNsTokenIsAValidES256Signature() throws {
        let auth = try APNsAuthToken(keyID: "KEY1234567", teamID: "ABCDE12345", p8: testP8)
        let token = try auth.token(issuedAt: Date(timeIntervalSince1970: 1_760_860_800))
        let parts = token.split(separator: ".").map(String.init)
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(try decodeJSON(parts[0]) as? [String: String], ["alg": "ES256", "kid": "KEY1234567"])
        let claims = try decodeJSON(parts[1]) as? [String: Any]
        XCTAssertEqual(claims?["iss"] as? String, "ABCDE12345")
        XCTAssertEqual(claims?["iat"] as? Int, 1_760_860_800)

        let key = try P256.Signing.PrivateKey(pemRepresentation: testP8)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: try base64URL(parts[2]))
        XCTAssertTrue(key.publicKey.isValidSignature(signature, for: Data((parts[0] + "." + parts[1]).utf8)))

        // Windows line ends and a byte-order mark (a key saved through another app) still read.
        XCTAssertNoThrow(try APNsAuthToken(keyID: "KEY1234567", teamID: "ABCDE12345", p8: "\u{FEFF}" + testP8.replacingOccurrences(of: "\n", with: "\r\n")))
        XCTAssertThrowsError(try APNsAuthToken(keyID: "short", teamID: "ABCDE12345", p8: testP8))
        XCTAssertThrowsError(try APNsAuthToken(keyID: "KEY1234567", teamID: "ABCDE12345", p8: "not a key"))
    }

    func testBuildsTheAPNsRequestTrioExpects() throws {
        let auth = try APNsAuthToken(keyID: "KEY1234567", teamID: "ABCDE12345", p8: testP8)
        let request = try TrioCommandRequestBuilder.request(payload: mealPayload(), target: target, sharedSecret: "trio-secret", authToken: auth, now: Date(timeIntervalSince1970: 1_760_860_800))
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://api.push.apple.com/3/device/" + String(repeating: "ab", count: 32))
        XCTAssertEqual(request.value(forHTTPHeaderField: "apns-topic"), "org.nightscout.ABCDE12345.trio")
        XCTAssertEqual(request.value(forHTTPHeaderField: "apns-push-type"), "alert")
        XCTAssertEqual(request.value(forHTTPHeaderField: "apns-priority"), "10")
        XCTAssertEqual(request.value(forHTTPHeaderField: "apns-expiration"), "0")
        XCTAssertNil(request.value(forHTTPHeaderField: "apns-collapse-id"))
        XCTAssertTrue(request.value(forHTTPHeaderField: "authorization")?.hasPrefix("bearer ") == true)

        let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        let aps = body?["aps"] as? [String: Any]
        XCTAssertEqual(aps?["content-available"] as? Int, 1)
        XCTAssertEqual(aps?["interruption-level"] as? String, "time-sensitive")
        XCTAssertEqual(aps?["alert"] as? String, "Zdalne polecenie: posiłek z bolusem")
        let decrypted = try TrioSecureMessenger(sharedSecret: "trio-secret").decrypt(body?["encrypted_data"] as? String ?? "")
        XCTAssertEqual((try JSONSerialization.jsonObject(with: decrypted) as? [String: Any])?["command_type"] as? String, "meal")
    }

    func testRefusesToAddressAnUnreadyTrioOrAKeyOfAnotherTeam() throws {
        let auth = try APNsAuthToken(keyID: "KEY1234567", teamID: "ABCDE12345", p8: testP8)
        let missing = TrioRemoteTarget(status: "MISSING_TOKEN", device_token: nil, bundle_id: "b", team_id: "ABCDE12345", apns_environment: "sandbox", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil)
        XCTAssertThrowsError(try TrioCommandRequestBuilder.request(payload: mealPayload(), target: missing, sharedSecret: "s", authToken: auth, now: Date())) { error in
            XCTAssertEqual(error as? TrioRemoteError, .invalidTarget("MISSING_TOKEN"))
        }
        let otherTeam = try APNsAuthToken(keyID: "KEY1234567", teamID: "ZZZZZ99999", p8: testP8)
        XCTAssertThrowsError(try TrioCommandRequestBuilder.request(payload: mealPayload(), target: target, sharedSecret: "s", authToken: otherTeam, now: Date())) { error in
            XCTAssertEqual(error as? TrioRemoteError, .invalidTarget("TEAM_MISMATCH"))
        }
        let sandbox = TrioRemoteTarget(status: "READY", device_token: "ab", bundle_id: "b", team_id: "ABCDE12345", apns_environment: "sandbox", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil)
        XCTAssertEqual(try TrioCommandRequestBuilder.request(payload: mealPayload(), target: sandbox, sharedSecret: "s", authToken: auth, now: Date()).url?.host, "api.sandbox.push.apple.com")
    }

    func testExplainsAPNsAnswers() {
        XCTAssertEqual(APNsSendResult(status: 200, body: Data()), .accepted)
        XCTAssertEqual(APNsSendResult(status: 410, body: Data(#"{"reason":"Unregistered"}"#.utf8)).message, "Nie udało się wysłać: adres Trio jest nieaktualny; otwórz Trio na telefonie pacjenta, żeby wysłało nowy profil")
        XCTAssertEqual(APNsSendResult(status: 403, body: Data(#"{"reason":"InvalidProviderToken"}"#.utf8)).message, "Nie udało się wysłać: klucz APNs nie pasuje do zespołu, który zbudował Trio, albo jest nieważny")
        XCTAssertEqual(APNsSendResult(status: 418, body: Data()).message, "Nie udało się wysłać: APNs odpowiedział 418")
    }

    func testSettingsSayWhatIsMissing() {
        XCTAssertEqual(TrioRemoteSettings().problems(trio: target), ["Wpisz Shared Secret z Trio (Ustawienia → Remote Control).", "Key ID klucza APNs to 10 wielkich liter lub cyfr.", "Wczytaj klucz APNs (plik .p8)."])
        let good = TrioRemoteSettings(sharedSecret: "s", apnsKeyID: "KEY1234567", apnsKeyP8: testP8)
        XCTAssertEqual(good.problems(trio: target), [])
        var badKey = good
        badKey.apnsKeyP8 = "nope"
        XCTAssertEqual(badKey.problems(trio: target), ["Klucz APNs (.p8) jest niepoprawny."])
        var loose = good
        loose.maxBolusUnits = 50
        XCTAssertEqual(loose.problems(trio: target).count, 1)
    }

    func testSettingsStoreKeepsEachPatientApart() throws {
        let store = InMemoryTrioRemoteSettingsStore()
        try store.save(TrioRemoteSettings(sharedSecret: "a"), patientID: "P1")
        XCTAssertEqual(try store.load(patientID: "p1")?.sharedSecret, "a")
        XCTAssertNil(try store.load(patientID: "p2"))
        try store.clear(patientID: "p1")
        XCTAssertNil(try store.load(patientID: "p1"))
    }

    private func base64URL(_ value: String) throws -> Data {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        return try XCTUnwrap(Data(base64Encoded: base64))
    }

    private func decodeJSON(_ part: String) throws -> Any {
        try JSONSerialization.jsonObject(with: try base64URL(part))
    }
}
