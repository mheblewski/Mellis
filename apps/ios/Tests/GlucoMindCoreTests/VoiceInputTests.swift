import XCTest
@testable import GlucoMindCore

@MainActor
final class VoiceInputTests: XCTestCase {
    func testTranscribeSendsTheRecordingAndReturnsItsText() async throws {
        var captured: URLRequest?
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authorizationMode: .none,
            httpClient: VoiceClosureHTTPClient { request in
                captured = request
                return (Data(#"{"patient_id":"patient-1","text":"Cukier 145, strzałka w dół","duration_seconds":3.2}"#.utf8), 200)
            }
        )

        let model = ConversationViewModel(apiClient: client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        let text = try await model.voiceTranscribe(Data([0x00, 0x00, 0x00, 0x18]))

        XCTAssertEqual(text, "Cukier 145, strzałka w dół")
        let request = try XCTUnwrap(captured)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/patients/patient-1/transcriptions")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String])
        XCTAssertEqual(body["content_type"], "audio/mp4")
        XCTAssertEqual(body["data_base64"], Data([0x00, 0x00, 0x00, 0x18]).base64EncodedString())
    }

    func testServerRefusalsReadAsPlainMessages() {
        XCTAssertEqual(VoiceInputController.message(for: APIClientError.conflict(nil)), "Mówienie zamiast pisania jest wyłączone na serwerze.")
        XCTAssertEqual(VoiceInputController.message(for: APIClientError.transport("offline")), "Brak połączenia. Nagranie nie zostało wysłane.")
        XCTAssertEqual(VoiceInputController.message(for: APIClientError.unexpectedStatus(503, nil)), "Nie udało się rozpoznać mowy. Spróbuj jeszcze raz.")
    }

    func testPathFollowsTheServerAndKeepsTheServerWhenUnknown() {
        XCTAssertEqual(VoiceTranscriptionPath.choose(serverTranscription: true), .server)
        XCTAssertEqual(VoiceTranscriptionPath.choose(serverTranscription: false), .onDevice)
        // Not read yet, or a server from before the field: as before.
        XCTAssertEqual(VoiceTranscriptionPath.choose(serverTranscription: nil), .server)
    }

    func testAppConfigReadsTheVoiceFieldAndToleratesOlderServers() throws {
        let current = try JSONDecoder().decode(AppConfigResponse.self, from: Data(#"{"ios":{"min_build":445,"update_message":"x"},"voice":{"server_transcription":false}}"#.utf8))
        XCTAssertEqual(current.voice?.server_transcription, false)
        let older = try JSONDecoder().decode(AppConfigResponse.self, from: Data(#"{"ios":{"min_build":445,"update_message":"x"}}"#.utf8))
        XCTAssertNil(older.voice)
    }

    func testRoutedTranscribeUsesTheServerOrThePhone() async throws {
        var calls: [String] = []
        let settings = VoiceTranscriptionSettings()
        let transcribe = routedVoiceTranscribe(
            server: { _ in calls.append("server"); return "z serwera" },
            onDevice: { _ in calls.append("phone"); return "z telefonu" },
            settings: settings
        )

        let unknown = try await transcribe(Data([1]))
        XCTAssertEqual(unknown, "z serwera")
        settings.serverTranscription = true
        let server = try await transcribe(Data([1]))
        XCTAssertEqual(server, "z serwera")
        settings.serverTranscription = false
        let phone = try await transcribe(Data([1]))
        XCTAssertEqual(phone, "z telefonu")
        XCTAssertEqual(calls, ["server", "server", "phone"])
    }

    func testServerRefusalMovesToThePhoneButOtherErrorsDoNot() async throws {
        var phoneCalls = 0
        let refusing = routedVoiceTranscribe(
            server: { _ in throw APIClientError.conflict(nil) },
            onDevice: { _ in phoneCalls += 1; return "z telefonu" },
            settings: VoiceTranscriptionSettings(serverTranscription: true)
        )
        let text = try await refusing(Data([1]))
        XCTAssertEqual(text, "z telefonu")

        let offline = routedVoiceTranscribe(
            server: { _ in throw APIClientError.transport("offline") },
            onDevice: { _ in phoneCalls += 1; return "z telefonu" },
            settings: VoiceTranscriptionSettings(serverTranscription: true)
        )
        do {
            _ = try await offline(Data([1]))
            XCTFail("expected the transport error")
        } catch APIClientError.transport {
        }
        XCTAssertEqual(phoneCalls, 1)
    }

    func testPhonePathErrorsReadAsPlainMessages() {
        XCTAssertEqual(VoiceInputController.message(for: OnDeviceSpeechError.notAuthorized), "Włącz rozpoznawanie mowy dla Mellis w Ustawieniach, żeby mówić zamiast pisać.")
        XCTAssertEqual(VoiceInputController.message(for: OnDeviceSpeechError.unavailable), "Rozpoznawanie mowy po polsku jest teraz niedostępne na tym telefonie.")
        XCTAssertTrue(OnDeviceSpeechTranscriber.isNoSpeech(NSError(domain: "kAFAssistantErrorDomain", code: 1110)))
        XCTAssertFalse(OnDeviceSpeechTranscriber.isNoSpeech(NSError(domain: NSURLErrorDomain, code: -1009)))
    }

    func testLevelsRunFromSilenceToLoud() {
        XCTAssertEqual(VoiceInputController.level(fromDecibels: -160), 0)
        XCTAssertEqual(VoiceInputController.level(fromDecibels: -50), 0)
        XCTAssertEqual(VoiceInputController.level(fromDecibels: 0), 1)
        XCTAssertEqual(VoiceInputController.level(fromDecibels: .nan), 0)
        let speech = VoiceInputController.level(fromDecibels: -20)
        XCTAssertGreaterThan(speech, 0.3)
        XCTAssertLessThan(speech, 0.8)
    }
}

private final class VoiceClosureHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
