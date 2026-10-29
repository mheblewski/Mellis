import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The inside of a chat's composer, as in ChatGPT: "+" (camera or library), the text and the send or stop button, the
/// photos picked for the message above them. The same in Rozmowy and in the meal chat; `chatComposerChrome()` puts it
/// in its glass bubble.
struct ChatComposerBar<Action: View>: View {
    let placeholder: String
    @Binding var text: String
    @Binding var isFocused: Bool
    let photos: [Data]
    let canAddPhoto: Bool
    /// The picked photos cannot be removed while the message is being sent.
    var photosLocked = false
    let onRemovePhoto: (Int) -> Void
    let onCamera: () -> Void
    let onLibrary: () -> Void
    /// Takes photos pasted from the clipboard; nil while no photo can be added (paste is then text only).
    let onPastePhotos: (([Data]) -> Void)?
    /// Speech to text for the mic next to the send button; nil hides the mic.
    var voiceInput: VoiceTranscribe? = nil
    /// The send button, or the stop button while an analysis can be stopped.
    @ViewBuilder let action: () -> Action

    @StateObject private var voice = VoiceInputController()
    /// The keyboard was up when recording started: it comes back with the text.
    @State private var refocusAfterVoice = false

    var body: some View {
        VStack(spacing: 0) {
            if let message = voice.errorMessage {
                voiceError(message)
            }
            if !photos.isEmpty {
                photoStrip
            }
            HStack(alignment: .bottom, spacing: 4) {
                if voice.phase == .idle {
                    photoMenu
                    // Stays editable while a reply is pending, so the next message can be drafted.
                    ComposerTextField(
                        placeholder: placeholder,
                        text: $text,
                        isFocused: $isFocused,
                        maxLines: 6,
                        onPastePhotos: onPastePhotos
                    )
                    // One line is as tall as the 38 pt buttons, so the text sits on their center line.
                    .padding(.vertical, 8)

                    if let voiceInput {
                        micButton(voiceInput)
                    }
                    action()
                } else {
                    voiceRecordingRow
                }
            }
            .padding(5)
        }
        .animation(.easeOut(duration: 0.15), value: voice.phase)
        .task(id: voice.errorMessage) {
            guard voice.errorMessage != nil else { return }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            voice.errorMessage = nil
        }
        .onDisappear { voice.cancel() }
    }

    // MARK: - Voice input

    /// Records a voice message; its text lands in the field to be read and sent (nothing is sent on its own).
    private func micButton(_ transcribe: @escaping VoiceTranscribe) -> some View {
        Button {
            refocusAfterVoice = isFocused
            isFocused = false
            Task {
                await voice.start(transcribe: transcribe) { transcript in
                    insertTranscript(transcript)
                }
            }
        } label: {
            Image(systemName: "mic")
                .font(.system(size: 19, weight: .regular))
                .foregroundStyle(Color.primary)
                .frame(width: 38, height: 38)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Mów zamiast pisać")
    }

    /// While recording: ✕ drops it, the waveform shows it is listening, ✓ turns it into text (a spinner meanwhile).
    private var voiceRecordingRow: some View {
        Group {
            Button {
                voice.cancel()
                if refocusAfterVoice { isFocused = true }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .frame(width: 38, height: 38)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Anuluj nagrywanie")

            VoiceWaveform(levels: voice.levels, isLive: voice.phase == .recording)
                .frame(maxWidth: .infinity)
                .frame(height: 38)
                .accessibilityLabel(voice.phase == .recording ? "Nagrywanie" : "Rozpoznawanie mowy")

            Text(Self.clock(voice.elapsed))
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(height: 38)
                .padding(.horizontal, 4)

            Button {
                voice.finish()
            } label: {
                Group {
                    if voice.phase == .transcribing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(checkmarkColor)
                    }
                }
                .frame(width: 38, height: 38)
                .background(Circle().fill(voice.phase == .transcribing ? Color.secondary.opacity(0.18) : Color.primary))
            }
            .buttonStyle(.plain)
            .disabled(voice.phase != .recording)
            .accessibilityLabel(voice.phase == .transcribing ? "Rozpoznaję mowę" : "Gotowe")
        }
    }

    private func voiceError(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.circle")
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .onTapGesture { voice.errorMessage = nil }
    }

    /// Appended to what is already typed, with a space between.
    private func insertTranscript(_ transcript: String) {
        if text.isEmpty {
            text = transcript
        } else {
            text += (text.last?.isWhitespace == true ? "" : " ") + transcript
        }
        if refocusAfterVoice { isFocused = true }
    }

    private static func clock(_ elapsed: TimeInterval) -> String {
        let seconds = max(0, Int(elapsed))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// The checkmark is drawn in the background color on a primary (black or white) circle.
    private var checkmarkColor: Color {
        #if canImport(UIKit)
        Color(uiColor: .systemBackground)
        #else
        Color.white
        #endif
    }

    /// Photos (a meal, a label) go with the next message, at most three.
    private var photoMenu: some View {
        Menu {
            #if os(iOS)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button(action: onCamera) {
                    Label("Aparat", systemImage: "camera")
                }
            }
            #endif
            Button(action: onLibrary) {
                Label("Zdjęcia", systemImage: "photo")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(canAddPhoto ? Color.primary : Color.secondary)
                .frame(width: 38, height: 38)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canAddPhoto)
        .accessibilityLabel("Dodaj zdjęcie")
    }

    private var photoStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(photos.enumerated()), id: \.offset) { index, data in
                    ZStack(alignment: .topTrailing) {
                        MealPhotoThumbnail(data: data, size: 64)
                        Button {
                            onRemovePhoto(index)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .offset(x: 6, y: -6)
                        .disabled(photosLocked)
                        .accessibilityLabel("Usuń zdjęcie")
                    }
                }
            }
            .padding(.top, 12)
            .padding(.horizontal, 16)
        }
    }
}

/// What the mic hears, as in ChatGPT: a bar per moment, newest on the right, dots where nothing was recorded yet.
/// Dimmed once recording stops and the text is on its way.
struct VoiceWaveform: View {
    let levels: [Double]
    let isLive: Bool

    var body: some View {
        Canvas { context, size in
            let barWidth: CGFloat = 3
            let spacing: CGFloat = 2.5
            let count = max(1, Int((size.width + spacing) / (barWidth + spacing)))
            let shown = levels.suffix(count)
            let padding = count - shown.count
            let color = Color.primary.opacity(isLive ? 0.85 : 0.35)
            for slot in 0..<count {
                let x = CGFloat(slot) * (barWidth + spacing)
                let height: CGFloat
                if slot < padding {
                    height = barWidth
                } else {
                    let level = shown[shown.startIndex + (slot - padding)]
                    height = max(barWidth, CGFloat(level) * size.height * 0.8)
                }
                let rect = CGRect(x: x, y: (size.height - height) / 2, width: barWidth, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(slot < padding ? Color.secondary.opacity(0.35) : color))
            }
        }
    }
}

/// The round send button of a chat's composer; a spinner in its place while the message is being sent.
struct ChatSendButton: View {
    let isEnabled: Bool
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(isEnabled ? Color.white : Color.secondary)
                }
            }
            .frame(width: 38, height: 38)
            .background(Circle().fill(isEnabled && !isBusy ? Color.accentColor : Color.secondary.opacity(0.18)))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || isBusy)
        .accessibilityLabel(isBusy ? "Wysyłam" : "Wyślij")
    }
}

extension View {
    /// The composer's glass bubble, floating over the chat above the bottom edge.
    func chatComposerChrome() -> some View {
        glassBubble(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
    }
}
