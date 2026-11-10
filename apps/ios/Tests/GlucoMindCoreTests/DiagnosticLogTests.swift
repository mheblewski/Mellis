import XCTest
@testable import GlucoMindCore

final class DiagnosticLogTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("diagnostics-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testDropsWhatIsNotACode() {
        let fields = DiagnosticSanitizer.fields([
            "status": "500",
            "code": "NOT_AN_OWNER",
            "reason": "Kuba nie odpowiada",
            "host": "https://secret-host.example/api",
            "mail": "mama@example.com",
            "id": "6f1c2c1e-3a53-4f4e-9c55-0c8f0d8a1b11",
            "phone": "48601234567",
            "route": "/v1/patients/6f1c2c1e-3a53-4f4e-9c55-0c8f0d8a1b11/dashboard",
        ])
        XCTAssertEqual(fields, ["status": "500", "code": "NOT_AN_OWNER"])
    }

    func testKeepsNegativeSystemCodes() {
        XCTAssertEqual(DiagnosticSanitizer.fields(["url_error": "-1004", "code": "-25308"]), ["url_error": "-1004", "code": "-25308"])
        XCTAssertEqual(DiagnosticSanitizer.errorCode(TrioRemoteSettingsStoreError.keychain(-25308)), "-25308")
        XCTAssertEqual(DiagnosticSanitizer.errorCode(URLError(.cannotConnectToHost)), "-1004")
    }

    func testRouteTemplateHasNoIdentifiersOrQuery() {
        let url = URL(string: "https://secret-host.example/v1/patients/6F1C2C1E-3A53-4F4E-9C55-0C8F0D8A1B11/meals/abc123/chat?date=2026-11-07&q=Kuba")
        XCTAssertEqual(DiagnosticSanitizer.routeTemplate(url), "/v1/patients/:id/meals/:id/chat")
        XCTAssertEqual(DiagnosticSanitizer.routeTemplate(URL(string: "https://x.example/v1/devices/device-1/settings")), "/v1/devices/:id/settings")
        XCTAssertEqual(DiagnosticSanitizer.fields(["route": DiagnosticSanitizer.routeTemplate(url)]), ["route": "/v1/patients/:id/meals/:id/chat"])
    }

    func testCodingPathKeepsKeysOnly() {
        struct Key: CodingKey {
            var stringValue: String
            var intValue: Int?
            init(_ string: String) { stringValue = string }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { self.intValue = intValue; stringValue = "\(intValue)" }
        }
        XCTAssertEqual(DiagnosticSanitizer.codingPath([Key("meals"), Key(intValue: 3)!, Key("carbs_g")]), "meals.n.carbs_g")
        XCTAssertEqual(DiagnosticSanitizer.codingPath([]), "root")
    }

    func testWritesNothingUntilEnabled() {
        let log = DiagnosticLog(directory: directory)
        log.record(.app, "before_enable")
        XCTAssertEqual(log.entries(), [])
        log.enable()
        log.record(.app, "after_enable", ["status": "500", "reason": "dwa słowa"])
        let entries = log.entries()
        XCTAssertEqual(entries.map(\.event), ["after_enable"])
        XCTAssertEqual(entries.first?.fields, ["status": "500"])
    }

    func testRefusesAnEventNameThatIsNotACode() {
        let log = DiagnosticLog(directory: directory)
        log.enable()
        log.record(.app, "Kuba ma hipo")
        XCTAssertEqual(log.entries(), [])
    }

    func testRotatesAndForgetsOldEntries() {
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let log = DiagnosticLog(directory: directory, now: { clock }, maxBytes: 300)
        log.enable()
        for index in 0..<20 {
            log.record(.network, "request_failed", ["attempt": "\(index)"])
            _ = log.entries()
        }
        let kept = log.entries()
        XCTAssertLessThan(kept.count, 20)
        XCTAssertEqual(kept.last?.fields["attempt"], "19")
        clock = clock.addingTimeInterval(DiagnosticLog.retention + 1)
        XCTAssertEqual(log.entries(), [])
    }

    func testEntriesReturnsTheNewestWithinTheLimit() {
        let log = DiagnosticLog(directory: directory)
        log.enable()
        for index in 0..<5 { log.record(.app, "e\(index)") }
        XCTAssertEqual(log.entries(limit: 2).map(\.event), ["e3", "e4"])
    }
}

final class DiagnosticReportTests: XCTestCase {
    private let facts = DiagnosticPhoneFacts(appVersion: "1.0.34 (1300 · abc1234)", deviceModel: "iPhone16,1", systemVersion: "26.1", timeZone: "Europe/Warsaw", utcOffsetMinutes: 60, lowPowerMode: false, backgroundRefresh: "włączone", notificationAuthorization: "jest", notificationAlerts: "włączone", notificationSounds: "wyłączone", registeredForPushes: true, deviceSignIn: true, patients: 2, remoteSetupComplete: true)
    private let now = Date(timeIntervalSince1970: 1_794_000_000)

    func testJoinsThePhoneAndTheServer() {
        let entries = [
            DiagnosticEntry(at: now.addingTimeInterval(-60), category: .network, event: "request_failed", fields: ["status": "500", "route": "/v1/me/patients"]),
            DiagnosticEntry(at: now.addingTimeInterval(-10), category: .app, event: "app_active", fields: [:]),
        ]
        let text = DiagnosticReportText.build(now: now, facts: facts, entries: entries, server: .report("RAPORT SERWERA\n  Wersja: 1.0.34\n"))
        XCTAssertTrue(text.contains("Aplikacja: 1.0.34 (1300 · abc1234)"))
        XCTAssertTrue(text.contains("Strefa czasowa: Europe/Warsaw (UTC+60 min)"))
        XCTAssertTrue(text.contains("dźwięki wyłączone"))
        XCTAssertTrue(text.contains("network request_failed route=/v1/me/patients status=500"))
        XCTAssertTrue(text.contains("RAPORT SERWERA\n  Wersja: 1.0.34"))
        let newest = text.range(of: "app_active")!.lowerBound
        let older = text.range(of: "request_failed")!.lowerBound
        XCTAssertLessThan(newest, older)
    }

    func testServerFailuresBecomeCodes() {
        XCTAssertEqual(DiagnosticServerPart(error: APIClientError.forbidden(nil)), .notOwner)
        XCTAssertEqual(DiagnosticServerPart(error: APIClientError.notFound(nil)), .unavailable("STARSZA_WERSJA_SERWERA"))
        XCTAssertEqual(DiagnosticServerPart(error: APIClientError.unexpectedStatus(503, nil)), .unavailable("HTTP_503"))
        XCTAssertEqual(DiagnosticServerPart(error: APIClientError.transport("secret-host.example nie odpowiada")), .unavailable("BRAK_POLACZENIA"))
        XCTAssertEqual(DiagnosticServerPart(error: URLError(.timedOut)), .unavailable("BRAK_ODPOWIEDZI"))
    }

    func testAReportWithoutTheServerSaysWhy() {
        let notOwner = DiagnosticReportText.build(now: now, facts: facts, entries: [], server: .notOwner)
        XCTAssertTrue(notOwner.contains("ten telefon nie należy do właściciela"))
        XCTAssertTrue(notOwner.contains("ZDARZENIA TELEFONU (7 dni, najnowsze na górze)\n  brak"))
        XCTAssertNotNil(DiagnosticServerPart.notOwner.screenNote)
        XCTAssertNil(DiagnosticServerPart.report("x").screenNote)
        XCTAssertTrue(DiagnosticReportText.build(now: now, facts: facts, entries: [], server: .unavailable("HTTP_503")).contains("niedostępny (HTTP_503)"))
    }

    func testFileNameIsSafe() {
        XCTAssertTrue(DiagnosticReportText.fileName(now: now).hasPrefix("mellis-raport-"))
        XCTAssertTrue(DiagnosticReportText.fileName(now: now).hasSuffix(".txt"))
    }
}
