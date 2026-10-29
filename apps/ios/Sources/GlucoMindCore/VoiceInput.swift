import AVFoundation
import Combine
import Foundation
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
/// and sent like a typed one (nothing is sent on its own). One recording at a time; the audio file is deleted at once.
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

    private static let levelHistory = 80

    private var recorder: AVAudioRecorder?
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
        guard phase == .idle else { return }
        errorMessage = nil
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
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        // The bar shows the recording at once; ✓ waits for the recorder.
        phase = .starting
        startedAt = Date()
        elapsed = 0
        levels = []
        self.transcribe = transcribe
        self.onText = onText
        let attempt = UUID()
        startAttempt = attempt
        do {
            // Off the main thread: starting the audio input can wait on the audio device (seconds in the Simulator),
            // and the app must stay responsive meanwhile.
            let recorder = try await Task.detached(priority: .userInitiated) {
                try Self.makeRecordingRecorder(url: url)
            }.value
            guard startAttempt == attempt, phase == .starting else {
                // Cancelled while the recorder was starting.
                recorder.stop()
                try? FileManager.default.removeItem(at: url)
                return
            }
            self.recorder = recorder
            self.fileURL = url
            startedAt = Date()
            phase = .recording
            #if os(iOS)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            #endif
            startMetering()
        } catch {
            try? FileManager.default.removeItem(at: url)
            guard startAttempt == attempt else { return }
            cleanUp()
            phase = .idle
            errorMessage = "Nie udało się włączyć nagrywania."
        }
    }

    /// A recorder already recording into `url`, with the audio session set up for it.
    private nonisolated static func makeRecordingRecorder(url: URL) throws -> AVAudioRecorder {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        #endif
        // AAC mono at 16 kHz and 24 kbit/s (the encoder's limit at that rate): speech stays clear, two minutes are
        // about 360 kB.
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 24_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.isMeteringEnabled = true
        guard recorder.record(forDuration: maxSeconds) else {
            throw VoiceInputError.recorderDidNotStart
        }
        return recorder
    }

    /// Drops the recording without sending it, or stops waiting for its text.
    public func cancel() {
        transcribeTask?.cancel()
        transcribeTask = nil
        recorder?.stop()
        cleanUp()
        phase = .idle
    }

    /// Stops the recording and sends it for transcription.
    public func finish() {
        guard phase == .recording, let recorder, let fileURL, let transcribe else { return }
        let duration = recorder.currentTime > 0 ? recorder.currentTime : elapsed
        recorder.stop()
        stopMetering()
        deactivateSession()
        let data = try? Data(contentsOf: fileURL)
        try? FileManager.default.removeItem(at: fileURL)
        self.recorder = nil
        self.fileURL = nil
        guard let data, !data.isEmpty, duration >= 0.5 else {
            cleanUp()
            phase = .idle
            errorMessage = "Nagranie było za krótkie."
            return
        }
        phase = .transcribing
        transcribeTask = Task { [weak self] in
            do {
                let text = try await transcribe(data)
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
                self.errorMessage = Self.message(for: error)
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
                guard let self, self.phase == .recording, let recorder = self.recorder else { return }
                if !recorder.isRecording {
                    // Stopped at the 120 s limit (or by the system): send what was said.
                    self.finish()
                    return
                }
                recorder.updateMeters()
                self.levels.append(Self.level(fromDecibels: recorder.averagePower(forChannel: 0)))
                if self.levels.count > Self.levelHistory {
                    self.levels.removeFirst(self.levels.count - Self.levelHistory)
                }
                self.elapsed = Date().timeIntervalSince(self.startedAt ?? Date())
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
        recorder = nil
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
