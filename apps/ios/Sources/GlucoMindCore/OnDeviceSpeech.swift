import Foundation
import Speech

/// Where the mic's recording is turned into text.
public enum VoiceTranscriptionPath: Equatable {
    /// POST /v1/patients/{id}/transcriptions (OpenAI on the server).
    case server
    /// Apple Speech on the phone (pl-PL, on-device when the phone supports it): a server without an OpenAI key.
    case onDevice

    /// GET /v1/app-config's `voice.server_transcription`: only an explicit false moves to the phone. nil (not read yet,
    /// or a server from before the field) keeps the server, as before.
    public static func choose(serverTranscription: Bool?) -> VoiceTranscriptionPath {
        serverTranscription == false ? .onDevice : .server
    }
}

/// The server's voice setting, shared by every composer; the app sets it after reading GET /v1/app-config.
public final class VoiceTranscriptionSettings: @unchecked Sendable {
    public static let shared = VoiceTranscriptionSettings()

    private let lock = NSLock()
    private var storedServerTranscription: Bool?

    public init(serverTranscription: Bool? = nil) {
        storedServerTranscription = serverTranscription
    }

    public var serverTranscription: Bool? {
        get { lock.lock(); defer { lock.unlock() }; return storedServerTranscription }
        set { lock.lock(); storedServerTranscription = newValue; lock.unlock() }
    }

    public var path: VoiceTranscriptionPath {
        VoiceTranscriptionPath.choose(serverTranscription: serverTranscription)
    }
}

/// The composer's speech to text: the server when it transcribes, otherwise the phone. Chosen when a recording is
/// finished, so a setting read meanwhile counts. A server that refuses (409: voice off there, e.g. an app-config not
/// read yet) hands the recording to the phone instead of failing.
public func routedVoiceTranscribe(
    server: @escaping VoiceTranscribe,
    onDevice: @escaping VoiceTranscribe = { try await OnDeviceSpeechTranscriber.transcribe($0) },
    settings: VoiceTranscriptionSettings = .shared
) -> VoiceTranscribe {
    { audio in
        switch settings.path {
        case .onDevice:
            return try await onDevice(audio)
        case .server:
            do {
                return try await server(audio)
            } catch APIClientError.conflict {
                return try await onDevice(audio)
            }
        }
    }
}

public enum OnDeviceSpeechError: Error, Equatable {
    /// Speech recognition is not allowed for the app (Settings).
    case notAuthorized
    /// No Polish recognizer on this phone, or it is not available right now (offline without on-device support).
    case unavailable
}

/// Apple Speech for a recorded .m4a: Polish, on the phone when supported (nothing leaves it), the app's words as hints.
public enum OnDeviceSpeechTranscriber {
    public static let locale = Locale(identifier: "pl-PL")

    /// Words the recognizer would otherwise mishear (the same vocabulary as the server's transcription prompt).
    public static let contextualStrings = [
        "mg/dl", "WW", "WBT", "IOB", "COB", "bolus", "korekta", "dosłodzenie", "hipo", "baza", "sensor", "pompa",
        "Fiasp", "Trio", "Loop", "Nightscout", "Dexcom", "Libre", "AAPS", "węglowodany", "białko", "tłuszcz",
    ]

    /// Asks for speech recognition permission when needed; false when it is denied or restricted.
    public static func requestAuthorization() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        default:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        }
    }

    /// Checked when the mic is tapped on the on-device path, so the permission is asked before talking, not after.
    public static func preflight() async throws {
        guard await requestAuthorization() else { throw OnDeviceSpeechError.notAuthorized }
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw OnDeviceSpeechError.unavailable
        }
    }

    public static func transcribe(_ m4aData: Data) async throws -> String {
        guard await requestAuthorization() else { throw OnDeviceSpeechError.notAuthorized }
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw OnDeviceSpeechError.unavailable
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        try m4aData.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.contextualStrings = contextualStrings
        request.addsPunctuation = true

        let once = ResumeOnce()
        let running = RecognitionTaskBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                running.set(recognizer.recognitionTask(with: request) { result, error in
                    if let result, result.isFinal {
                        if once.claim() { continuation.resume(returning: result.bestTranscription.formattedString) }
                    } else if let error {
                        guard once.claim() else { return }
                        // "No speech detected" reads as nothing said, like an empty server transcript.
                        if Self.isNoSpeech(error) {
                            continuation.resume(returning: "")
                        } else {
                            continuation.resume(throwing: error)
                        }
                    }
                })
            }
        } onCancel: {
            running.cancel()
        }
    }

    static func isNoSpeech(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == "kAFAssistantErrorDomain" && [203, 1110].contains(nsError.code)
    }
}

/// The running recognition, cancelled with the voice message (✕ while transcribing); a cancel before it starts sticks.
private final class RecognitionTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: SFSpeechRecognitionTask?
    private var cancelled = false

    func set(_ task: SFSpeechRecognitionTask) {
        lock.lock()
        self.task = task
        let cancelNow = cancelled
        lock.unlock()
        if cancelNow { task.cancel() }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}

/// The recognition callback can fire more than once (an error after the final result); the continuation resumes once.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
