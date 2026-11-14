import AVFoundation
import Combine
import Foundation
import Speech
#if canImport(UIKit)
import UIKit
#endif

public struct VoiceTranscriptionRequest: Encodable, Equatable {
    public let content_type: String
    public let data_base64: String
}

public struct VoiceTranscriptionResponse: Decodable, Equatable {
    public let patient_id: String
    public let text: String
    public let duration_seconds: Double
}

/// Speech to text on the server (POST /v1/patients/{id}/transcriptions), as ChatGPT's dictation: better Polish and
/// diabetes words than the keyboard's dictation. A server without it (no OpenAI key) has the phone transcribe instead
/// (OnDeviceSpeech.swift).
public protocol VoiceTranscriptionAPI {
    func transcribeVoice(patientID: String, m4aData: Data) async throws -> VoiceTranscriptionResponse
}

extension APIClient: VoiceTranscriptionAPI {}

/// Turns a recorded voice message (.m4a) into the text to put in the composer.
public typealias VoiceTranscribe = (Data) async throws -> String

/// The mic of a chat composer: records a voice message, sends it for transcription and hands the text back to be read
/// and sent like a typed one (nothing is sent on its own). While recording, Apple Speech shows the words as they are
/// said (`liveText`); the server's text replaces them at the end. One recording at a time; the audio file is deleted
/// at once.
@MainActor
public final class VoiceInputController: ObservableObject {
    public enum Phase: Equatable {
        case idle
        /// The recorder is being started (the bar already shows the recording).
        case starting
        case recording
        case transcribing
    }

    /// The server takes at most 120 s; the recording stops there and is transcribed.
    public nonisolated static let maxSeconds: TimeInterval = 120

    @Published public private(set) var phase: Phase = .idle
    /// Loudness of the latest moments, 0…1, oldest first (the waveform).
    @Published public private(set) var levels: [Double] = []
    @Published public private(set) var elapsed: TimeInterval = 0
    /// Why the last attempt gave no text; cleared by the next one.
    @Published public var errorMessage: String?
    /// The words heard so far (Apple Speech on the phone), empty when the phone cannot recognize them live.
    @Published public private(set) var liveText = ""

    private static let levelHistory = 80

    private var capture: VoiceCapture?
    private var live: LiveSpeechRecognizer?
    /// Released before the recorder was running (hold to talk): finished as soon as it runs.
    private var finishWhenStarted = false
    /// `start` is still checking the permissions.
    private var startInFlight = false
    private var fileURL: URL?
    private var startedAt: Date?
    private var meterTask: Task<Void, Never>?
    private var transcribeTask: Task<Void, Never>?
    private var transcribe: VoiceTranscribe?
    private var onText: ((String) -> Void)?
    /// The start in progress; a cancel clears it, so a recorder that starts late is stopped at once.
    private var startAttempt: UUID?
    /// Checked before recording: on the phone path, speech recognition must be allowed and available.
    private let preflight: () async throws -> Void

    public init(preflight: @escaping () async throws -> Void = VoiceInputController.defaultPreflight) {
        self.preflight = preflight
    }

    /// Nothing to check while the server transcribes; on the phone, Apple Speech's permission and Polish recognizer.
    public nonisolated static func defaultPreflight() async throws {
        guard VoiceTranscriptionSettings.shared.path == .onDevice else { return }
        try await OnDeviceSpeechTranscriber.preflight()
    }

    /// Starts recording after the microphone permission; `onText` gets the transcript when the recording is finished.
    public func start(transcribe: @escaping VoiceTranscribe, onText: @escaping (String) -> Void) async {
        guard beginStart() else { return }
        await performStart(transcribe: transcribe, onText: onText)
    }

    /// As `start`, from a tap or a hold: marked as starting at once, so a `finish()` right after it (a short hold)
    /// is not lost.
    public func startRecording(transcribe: @escaping VoiceTranscribe, onText: @escaping (String) -> Void) {
        guard beginStart() else { return }
        Task { await performStart(transcribe: transcribe, onText: onText) }
    }

    private func beginStart() -> Bool {
        guard phase == .idle, !startInFlight else { return false }
        errorMessage = nil
        finishWhenStarted = false
        startInFlight = true
        return true
    }

    private func performStart(transcribe: @escaping VoiceTranscribe, onText: @escaping (String) -> Void) async {
        defer { startInFlight = false }
        do {
            try await preflight()
        } catch {
            errorMessage = Self.message(for: error)
            return
        }
        guard phase == .idle else { return }
        guard await Self.requestPermission() else {
            errorMessage = "Włącz dostęp do mikrofonu w Ustawieniach, żeby mówić zamiast pisać."
            return
        }
        guard phase == .idle else { return }
        // Asks for speech recognition once; without it the recording works as before, with no live words.
        let live = await LiveSpeechRecognizer.make()
        guard phase == .idle else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        // The bar shows the recording at once; ✓ waits for the recorder.
        phase = .starting
        startedAt = Date()
        elapsed = 0
        levels = []
        liveText = ""
        self.transcribe = transcribe
        self.onText = onText
        let attempt = UUID()
        startAttempt = attempt
        do {
            // Off the main thread: starting the audio input can wait on the audio device (seconds in the Simulator),
            // and the app must stay responsive meanwhile.
            let request = live?.request
            let capture = try await Task.detached(priority: .userInitiated) {
                try VoiceCapture.start(url: url, maxSeconds: Self.maxSeconds, speech: request)
            }.value
            guard startAttempt == attempt, phase == .starting else {
                // Cancelled while the recorder was starting.
                _ = capture.stop()
                live?.cancel()
                try? FileManager.default.removeItem(at: url)
                return
            }
            self.capture = capture
            self.fileURL = url
            if let live {
                live.onText = { [weak self] text in
                    guard let self, self.live === live, self.phase != .idle else { return }
                    self.liveText = text
                }
                live.start()
                self.live = live
            }
            startedAt = Date()
            phase = .recording
            #if os(iOS)
            // The microphone is live: a felt tap says "talk now" (a hold gives no other sign under the finger).
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            #endif
            startMetering()
            if finishWhenStarted {
                finishWhenStarted = false
                finish()
            }
        } catch {
            live?.cancel()
            try? FileManager.default.removeItem(at: url)
            guard startAttempt == attempt else { return }
            cleanUp()
            phase = .idle
            errorMessage = "Nie udało się włączyć nagrywania."
        }
    }

    /// Drops the recording without sending it, or stops waiting for its text.
    public func cancel() {
        transcribeTask?.cancel()
        transcribeTask = nil
        _ = capture?.stop()
        cleanUp()
        phase = .idle
    }

    /// Stops the recording and turns it into text: the server's, or on the phone path the live words (the file is
    /// recognized again only when they are missing). Released while the recorder is still starting: right after it.
    public func finish() {
        if phase == .starting || (phase == .idle && startInFlight) {
            finishWhenStarted = true
            return
        }
        guard phase == .recording, let capture, let fileURL, let transcribe else { return }
        let duration = capture.stop()
        stopMetering()
        deactivateSession()
        let data = try? Data(contentsOf: fileURL)
        try? FileManager.default.removeItem(at: fileURL)
        self.capture = nil
        self.fileURL = nil
        let live = self.live
        guard let data, !data.isEmpty, duration >= 0.5 else {
            live?.cancel()
            cleanUp()
            phase = .idle
            errorMessage = "Nagranie było za krótkie."
            return
        }
        phase = .transcribing
        let onDevicePath = VoiceTranscriptionSettings.shared.path == .onDevice
        transcribeTask = Task { [weak self] in
            var heard = ""
            if let live {
                if onDevicePath {
                    heard = await live.finish(timeout: 2)
                } else {
                    heard = live.text
                    live.cancel()
                }
            }
            heard = heard.trimmingCharacters(in: .whitespacesAndNewlines)
            do {
                let text = onDevicePath && !heard.isEmpty ? heard : try await transcribe(data)
                guard let self, !Task.isCancelled else { return }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    self.errorMessage = "Nie rozpoznano żadnych słów. Spróbuj jeszcze raz."
                } else {
                    self.onText?(trimmed)
                }
                self.cleanUp()
                self.phase = .idle
            } catch {
                guard let self, !Task.isCancelled else { return }
                if !heard.isEmpty {
                    // The server did not answer: the words heard on the phone stay, to be read before sending.
                    self.onText?(heard)
                } else {
                    self.errorMessage = Self.message(for: error)
                }
                self.cleanUp()
                self.phase = .idle
            }
        }
    }

    // MARK: - Private

    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.phase == .recording, let capture = self.capture else { return }
                self.elapsed = Date().timeIntervalSince(self.startedAt ?? Date())
                if !capture.isRunning || self.elapsed >= Self.maxSeconds {
                    // At the 120 s limit, or stopped by the system (a call): send what was said.
                    self.finish()
                    return
                }
                self.levels.append(Self.level(fromDecibels: capture.averagePower))
                if self.levels.count > Self.levelHistory {
                    self.levels.removeFirst(self.levels.count - Self.levelHistory)
                }
                try? await Task.sleep(nanoseconds: 60_000_000)
            }
        }
    }

    private func stopMetering() {
        meterTask?.cancel()
        meterTask = nil
    }

    private func cleanUp() {
        stopMetering()
        deactivateSession()
        if let fileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        live?.cancel()
        live = nil
        liveText = ""
        capture = nil
        fileURL = nil
        transcribe = nil
        onText = nil
        transcribeTask = nil
        startAttempt = nil
    }

    private func deactivateSession() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    /// −50 dB and below is silence, 0 dB the loudest; the curve lifts normal speech into the middle of the bar.
    static func level(fromDecibels decibels: Float) -> Double {
        guard decibels.isFinite else { return 0 }
        let linear = max(0, min(1, (Double(decibels) + 50) / 50))
        return pow(linear, 1.6)
    }

    static func message(for error: Error) -> String {
        switch error as? OnDeviceSpeechError {
        case .notAuthorized?:
            return "Włącz rozpoznawanie mowy dla Mellis w Ustawieniach, żeby mówić zamiast pisać."
        case .unavailable?:
            return "Rozpoznawanie mowy po polsku jest teraz niedostępne na tym telefonie."
        case nil:
            break
        }
        switch error as? APIClientError {
        case .conflict?:
            return "Mówienie zamiast pisania jest wyłączone na serwerze."
        case .transport?:
            return "Brak połączenia. Nagranie nie zostało wysłane."
        case .validation?:
            return "Nie udało się odczytać nagrania. Spróbuj jeszcze raz."
        default:
            return "Nie udało się rozpoznać mowy. Spróbuj jeszcze raz."
        }
    }

    private static func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        default:
            return await AVAudioApplication.requestRecordPermission()
        }
    }
}

enum VoiceInputError: Error {
    case recorderDidNotStart
}

/// The microphone while recording: the sound goes into the .m4a for the server (AAC mono, 16 kHz, 24 kbit/s, as the
/// recorder before it: two minutes are about 360 kB) and, as it comes, to the live speech recognition.
final class VoiceCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private var framesWritten: AVAudioFramePosition = 0
    private var power: Float = -160
    private let fileSampleRate: Double

    private init(fileSampleRate: Double) {
        self.fileSampleRate = fileSampleRate
    }

    /// Starts the audio session and the microphone; the file at `url` fills until `stop()`.
    static func start(url: URL, maxSeconds: TimeInterval, speech: SFSpeechAudioBufferRecognitionRequest?) throws -> VoiceCapture {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        // iOS mutes haptics while an app records; the tap at the start of listening must be felt.
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        try session.setActive(true)
        #endif
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 24_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let capture = VoiceCapture(fileSampleRate: file.processingFormat.sampleRate)
        let input = capture.engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0,
              let converter = AVAudioConverter(from: inputFormat, to: file.processingFormat)
        else { throw VoiceInputError.recorderDidNotStart }
        capture.file = file
        capture.converter = converter
        let maxFrames = AVAudioFramePosition(maxSeconds * file.processingFormat.sampleRate)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak capture] buffer, _ in
            speech?.append(buffer)
            capture?.write(buffer, maxFrames: maxFrames)
        }
        capture.engine.prepare()
        do {
            try capture.engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw VoiceInputError.recorderDidNotStart
        }
        return capture
    }

    var isRunning: Bool { engine.isRunning }

    /// Loudness of the latest sound in dB (0 is the loudest).
    var averagePower: Float {
        lock.lock(); defer { lock.unlock() }
        return power
    }

    /// Stops the microphone and closes the file; returns the seconds recorded.
    func stop() -> TimeInterval {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        defer { lock.unlock() }
        // Releasing the file finishes the .m4a.
        file = nil
        converter = nil
        return Double(framesWritten) / fileSampleRate
    }

    private func write(_ buffer: AVAudioPCMBuffer, maxFrames: AVAudioFramePosition) {
        let decibels = Self.decibels(of: buffer)
        lock.lock()
        defer { lock.unlock() }
        power = decibels
        guard let file, let converter, framesWritten < maxFrames else { return }
        let ratio = file.processingFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, output.frameLength > 0 else { return }
        do {
            try file.write(from: output)
            framesWritten += AVAudioFramePosition(output.frameLength)
        } catch {
            return
        }
    }

    private static func decibels(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -160 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) {
            sum += channel[index] * channel[index]
        }
        let rms = (sum / Float(buffer.frameLength)).squareRoot()
        return rms > 0 ? 20 * log10(rms) : -160
    }
}
