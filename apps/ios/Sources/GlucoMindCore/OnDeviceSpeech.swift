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

/// Apple Speech on the microphone's sound while recording, so the words show up in the composer as they are said.
/// Only a preview: on the server path the server's text replaces it when the recording is finished.
@MainActor
final class LiveSpeechRecognizer {
    let request: SFSpeechAudioBufferRecognitionRequest
    /// The text so far, after every change.
    var onText: ((String) -> Void)?

    private let recognizer: SFSpeechRecognizer
    private var task: SFSpeechRecognitionTask?
    private var transcript = LiveTranscript()
    private var ended = false
    private var endWaiters: [CheckedContinuation<Void, Never>] = []

    /// nil when speech recognition is not allowed or no Polish recognizer is available: the recording goes on
    /// without live text.
    static func make() async -> LiveSpeechRecognizer? {
        guard await OnDeviceSpeechTranscriber.requestAuthorization(),
              let recognizer = SFSpeechRecognizer(locale: OnDeviceSpeechTranscriber.locale),
              recognizer.isAvailable
        else { return nil }
        return LiveSpeechRecognizer(recognizer: recognizer)
    }

    private init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.contextualStrings = OnDeviceSpeechTranscriber.contextualStrings
        request.addsPunctuation = true
        request.taskHint = .dictation
        self.request = request
    }

    var text: String { transcript.text }

    func start() {
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let partial = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let partial {
                    self.transcript.receive(partial, isFinal: isFinal)
                    self.onText?(self.transcript.text)
                }
                if isFinal || failed { self.markEnded() }
            }
        }
    }

    /// No more sound; waits (at most `timeout`) for the last words and returns the whole text.
    func finish(timeout: TimeInterval) async -> String {
        request.endAudio()
        if !ended {
            let waiter = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.markEnded()
            }
            await withCheckedContinuation { continuation in
                if ended { continuation.resume() } else { endWaiters.append(continuation) }
            }
            waiter.cancel()
        }
        task?.cancel()
        task = nil
        return transcript.text
    }

    func cancel() {
        request.endAudio()
        task?.cancel()
        task = nil
        markEnded()
    }

    private func markEnded() {
        ended = true
        let waiters = endWaiters
        endWaiters = []
        waiters.forEach { $0.resume() }
    }
}

/// The live text of one recording. Apple Speech starts its partial text over after a pause instead of extending it,
/// so what was said before the pause is kept.
struct LiveTranscript: Equatable {
    private var committed = ""
    private var current = ""

    var text: String { Self.join(committed, current) }

    mutating func receive(_ partial: String, isFinal: Bool) {
        if Self.startsOver(previous: current, next: partial) {
            committed = Self.join(committed, current)
        }
        current = partial
        if isFinal {
            committed = Self.join(committed, current)
            current = ""
        }
    }

    /// A shorter text with another first word is a new utterance; a correction keeps the beginning or grows.
    static func startsOver(previous: String, next: String) -> Bool {
        guard !previous.isEmpty, !next.isEmpty, next.count < previous.count else { return false }
        return firstWord(previous) != firstWord(next)
    }

    static func join(_ first: String, _ second: String) -> String {
        if first.isEmpty { return second }
        if second.isEmpty { return first }
        return first + " " + second
    }

    private static func firstWord(_ text: String) -> Substring {
        text.lowercased().split(whereSeparator: { $0.isWhitespace || $0.isPunctuation }).first ?? ""
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
