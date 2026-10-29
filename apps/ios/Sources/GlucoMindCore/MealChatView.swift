import SwiftUI
import PhotosUI
#if canImport(UIKit)
import UIKit
#endif

/// Meal chat: the caregiver describes the meal in text and/or photos, the AI proposes macros (DiabCalc products or its
/// own estimate) and may ask back; the caregiver accepts the proposal or types the values in.
public struct MealChatView: View {
    @StateObject private var viewModel: MealChatViewModel
    private let onClose: () -> Void

    @State private var libraryItems: [PhotosPickerItem] = []
    @State private var isLibraryPresented = false
    @State private var isCameraPresented = false
    @State private var isManualEntryPresented = false
    @State private var manualPrefill: MealChatProposal?
    @State private var isComposerFocused = false
    /// Height of the chat left visible above the composer and the keyboard.
    @State private var visibleChatHeight: CGFloat = 0
    @Environment(\.liveUpdates) private var liveUpdates
    /// Reveals of replies written on this screen, so a stored reply goes on from its draft.
    @StateObject private var revealStore = TextRevealStore()

    private let currentTurnID = "meal-chat-current-turn"
    private let bottomAnchorID = "meal-chat-bottom"

    public init(route: MealRoute, api: MealChatAPI, onClose: @escaping () -> Void) {
        _viewModel = StateObject(wrappedValue: MealChatViewModel(route: route, api: api))
        self.onClose = onClose
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        // Not lazy, as in the main chat: estimated rows put a sent message off the screen.
                        VStack(alignment: .leading, spacing: 0) {
                            if let chat = viewModel.chat {
                                MealChatHeader(meal: chat.meal)
                                if chat.messages.isEmpty {
                                    MealChatIntro()
                                        .padding(.top, 18)
                                }
                                let messages = chat.messages
                                let turnStart = messages.lastIndex(where: \.isFromCaregiver) ?? messages.count
                                ForEach(Array(messages.enumerated().prefix(turnStart)), id: \.element.id) { index, _ in
                                    messageRow(messages, at: index)
                                }
                                if turnStart < messages.count {
                                    // The latest caregiver message and the reply fill at least the visible height, so
                                    // the message can sit at the top of the screen however short the reply is.
                                    VStack(alignment: .leading, spacing: 0) {
                                        ForEach(Array(messages.enumerated().dropFirst(turnStart)), id: \.element.id) { index, _ in
                                            messageRow(messages, at: index)
                                        }
                                        replyStatus(chat)
                                    }
                                    // The bottom padding makes up the rest (the anchor below has no height).
                                    .frame(minHeight: max(0, visibleChatHeight - 16), alignment: .top)
                                    .id(currentTurnID)
                                } else {
                                    replyStatus(chat)
                                }
                            } else if viewModel.isLoading {
                                ProgressView("Wczytuję posiłek…")
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 40)
                            }
                            Color.clear
                                .frame(height: 0)
                                .id(bottomAnchorID)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 16)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    // The frame already excludes the top bar, the composer and the keyboard.
                    .onGeometryChange(for: CGFloat.self) { geometry in
                        geometry.size.height
                    } action: { height in
                        visibleChatHeight = height
                    }
                    .onChange(of: viewModel.chat == nil) { _, _ in
                        Task { @MainActor in
                            await Task.yield()
                            proxy.scrollTo(bottomAnchorID, anchor: .bottom)
                        }
                    }
                    // As in the main chat: a sent message moves to the top and the reply does not scroll it away.
                    .onChange(of: viewModel.isSending) { wasSending, isSending in
                        if wasSending, !isSending, viewModel.errorMessage == nil {
                            withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(currentTurnID, anchor: .top) }
                            Task { @MainActor in await ScrollPinCorrection.settle { proxy.scrollTo(currentTurnID, anchor: .top) } }
                        }
                    }
                }
            }
            // As in Rozmowy: the composer floats over the chat, which scrolls on under the glass.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composer
            }
            .navigationTitle("Posiłek")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij") {
                        viewModel.stopPolling()
                        onClose()
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        manualPrefill = nil
                        isManualEntryPresented = true
                    } label: {
                        Label("Edytuj posiłek", systemImage: "square.and.pencil")
                    }
                }
            }
            .task { await viewModel.load() }
            .task(id: liveUpdates.map(ObjectIdentifier.init)) { viewModel.bindLiveUpdates(liveUpdates) }
            // Closed by a swipe too, not only "Zamknij": no more reads in the background (load() resumes on return).
            .onDisappear { viewModel.stopPolling() }
            .photosPicker(isPresented: $isLibraryPresented, selection: $libraryItems, maxSelectionCount: 3, matching: .images)
            .onChange(of: libraryItems) { _, items in
                Task { await loadLibraryItems(items) }
            }
            #if os(iOS)
            .fullScreenCover(isPresented: $isCameraPresented) {
                CameraPicker { image in
                    if let jpeg = MealPhotoEncoder.jpeg(from: image) {
                        viewModel.addPhoto(jpeg)
                    }
                }
                .ignoresSafeArea()
            }
            #endif
            .sheet(isPresented: $isManualEntryPresented) {
                MealEditSheet(meal: viewModel.chat?.meal, proposal: manualPrefill) { edit in
                    await viewModel.saveEdit(&edit)
                }
            }
            .alert("Posiłek", isPresented: Binding(get: { viewModel.errorMessage != nil }, set: { if !$0 { viewModel.errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(viewModel.errorMessage ?? "")
            }
        }
    }

    /// A message with the spacing of Rozmowy: 18 pt between the caregiver's and GlucoMind's messages, 6 pt within them.
    private func messageRow(_ messages: [MealChatMessage], at index: Int) -> some View {
        let message = messages[index]
        let startsGroup = index == 0 || messages[index - 1].isFromCaregiver != message.isFromCaregiver
        return messageView(message, startsGroup: startsGroup)
            .padding(.top, startsGroup ? 18 : 6)
            .id(message.id)
    }

    /// While the reply is written: its text as it comes, or the step line of Rozmowy; a failed reply is the failure card.
    @ViewBuilder
    private func replyStatus(_ chat: MealChatResponse) -> some View {
        let lastCaregiverMessage = chat.messages.last(where: \.isFromCaregiver)
        // The reply opens a new group under the caregiver's message.
        let startsGroup = chat.messages.last?.isFromCaregiver ?? true
        if let draft = viewModel.visibleReplyDraft {
            // Laid out exactly like the stored reply that replaces it, so nothing moves when it arrives.
            StreamingAssistantMessageView(text: draft.content, showsAuthor: startsGroup, revealer: revealStore.revealer(for: draft.reply_to_message_id))
                .padding(.top, startsGroup ? 18 : 6)
        } else if chat.reply_pending {
            AgentStatusView(
                activity: .init(
                    phase: .analyzing,
                    title: "Analizuję posiłek…",
                    detail: nil,
                    startedAt: lastCaregiverMessage.flatMap { ServerDate.parse($0.created_at) }
                ),
                onRetry: {}
            )
            .padding(.top, 18)
        }
        if chat.reply_failed {
            AgentStatusView(
                activity: .init(phase: .failed, title: "Nie udało się przygotować odpowiedzi.", detail: nil, startedAt: nil),
                retryTitle: "Spróbuj ponownie",
                onRetry: { Task { await viewModel.retry() } }
            )
            .padding(.top, 18)
        }
    }

    @ViewBuilder
    private func messageView(_ message: MealChatMessage, startsGroup: Bool) -> some View {
        if message.isFromCaregiver {
            CaregiverMealMessage(message: message, viewModel: viewModel)
        } else if message.isConversationNote {
            // A change confirmed in a conversation (Rozmowy), by the caregiver who confirmed it: that line instead of
            // "Mellis".
            VStack(alignment: .leading, spacing: 6) {
                Label([String?.some("Zmiana z Rozmów"), message.author_display_name].compactMap { $0 }.joined(separator: " · "), systemImage: "bubble.left.and.bubble.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                AssistantMessageView(text: message.content, showsAuthor: false, attachment: replyCards(message))
            }
        } else if let revealer = revealStore.existing(for: message.reply_to_message_id) {
            // A reply written on this screen: its text goes on from the draft, the question and proposal follow.
            RevealingAssistantMessageView(text: message.content, showsAuthor: startsGroup, revealer: revealer, attachment: replyCards(message))
        } else {
            AssistantMessageView(text: message.content, showsAuthor: startsGroup, attachment: replyCards(message))
        }
    }

    /// The question and the proposal of a reply, right under its text (nil when it has neither).
    private func replyCards(_ message: MealChatMessage) -> AnyView? {
        guard message.question != nil || message.proposal != nil else { return nil }
        return AnyView(VStack(alignment: .leading, spacing: 10) {
            if let question = message.question {
                MealChatQuestionCard(question: question)
            }
            if let proposal = message.proposal {
                MealProposalCard(
                    proposal: proposal,
                    meal: viewModel.chat?.meal,
                    isLatest: message.id == viewModel.latestProposalMessageID,
                    isAccepting: viewModel.acceptingMessageID == message.id,
                    onAccept: { Task { await viewModel.accept(messageID: message.id) } },
                    onEdit: {
                        manualPrefill = proposal
                        isManualEntryPresented = true
                    }
                )
            }
        }
        .padding(.top, 4))
    }

    /// The composer of Rozmowy: one glass bubble with "+", the text and the send button.
    private var composer: some View {
        ChatComposerBar(
            placeholder: viewModel.chat?.messages.isEmpty == false ? "Odpowiedz albo doprecyzuj…" : "Np. kanapka z masłem i pół jabłka",
            text: $viewModel.draft,
            isFocused: $isComposerFocused,
            photos: viewModel.draftPhotos,
            canAddPhoto: viewModel.canAddPhoto && !viewModel.isSending,
            photosLocked: viewModel.isSending,
            onRemovePhoto: { viewModel.removeDraftPhoto(at: $0) },
            onCamera: { isCameraPresented = true },
            onLibrary: { isLibraryPresented = true },
            // A photo pasted from the clipboard goes with the description, as one added with "+".
            onPastePhotos: viewModel.canAddPhoto && !viewModel.isSending ? { photos in photos.forEach(viewModel.addPhoto) } : nil,
            voiceInput: viewModel.voiceTranscribe
        ) {
            ChatSendButton(isEnabled: viewModel.canSend, isBusy: viewModel.isSending) {
                isComposerFocused = false
                Task { await viewModel.send() }
            }
        }
        .chatComposerChrome()
    }

    private func loadLibraryItems(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard viewModel.canAddPhoto else { break }
            if let data = try? await item.loadTransferable(type: Data.self), let jpeg = MealPhotoEncoder.jpeg(fromImageData: data) {
                viewModel.addPhoto(jpeg)
            }
        }
        libraryItems = []
    }
}

struct MealChatHeader: View {
    let meal: MealDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(Self.time(meal.started_at))
                .font(.subheadline.weight(.semibold))
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var detail: String {
        var parts: [String] = []
        if let carbs = meal.source_carbs_g {
            parts.append("\(LoopFormat.number(carbs)) g WW w Nightscout")
        }
        if meal.trusted {
            parts.append("zatwierdzone: \(LoopFormat.macros(meal.macros))")
        }
        return parts.isEmpty ? "Posiłek" : parts.joined(separator: " · ")
    }

    static func time(_ iso: String) -> String {
        guard let date = ServerDate.parse(iso) else { return "Posiłek" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.setLocalizedDateFormatFromTemplate("EEEEdMMMMHHmm")
        let label = formatter.string(from: date)
        return label.prefix(1).uppercased() + label.dropFirst()
    }
}

struct MealChatIntro: View {
    var body: some View {
        Text("Opisz posiłek albo zrób zdjęcie – policzę węglowodany, białko i tłuszcz.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }
}

/// The caregiver's message as in Rozmowy: the photos, then the bubble with the author above it.
struct CaregiverMealMessage: View {
    let message: MealChatMessage
    @ObservedObject var viewModel: MealChatViewModel

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !message.photo_ids.isEmpty {
                HStack(spacing: 6) {
                    ForEach(message.photo_ids, id: \.self) { photoID in
                        RemoteMealPhoto(photoID: photoID, viewModel: viewModel)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            if !message.content.isEmpty || message.photo_ids.isEmpty {
                UserMessageBubble(text: message.content, author: message.author_display_name)
            }
        }
    }
}

/// The meal chat's question back, styled as the question card of Rozmowy; it is answered in the composer.
struct MealChatQuestionCard: View {
    let question: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Pytanie do Ciebie", systemImage: "questionmark.bubble.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Text(question)
                .font(.body.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: 680, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.accentColor.opacity(0.07))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.accentColor.opacity(0.35), lineWidth: 1)
        )
    }
}

struct RemoteMealPhoto: View {
    let photoID: String
    @ObservedObject var viewModel: MealChatViewModel
    @State private var data: Data?

    var body: some View {
        Group {
            if let data {
                MealPhotoThumbnail(data: data, size: 110)
            } else {
                RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.15))
                    .frame(width: 110, height: 110)
                    .overlay(ProgressView())
            }
        }
        .task(id: photoID) {
            data = await viewModel.photo(photoID)
        }
    }
}

struct MealPhotoThumbnail: View {
    let data: Data
    let size: CGFloat

    var body: some View {
        Group {
            #if canImport(UIKit)
            if let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.secondary.opacity(0.15)
            }
            #else
            Color.secondary.opacity(0.15)
            #endif
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityLabel("Zdjęcie posiłku")
    }
}

struct MealProposalCard: View {
    let proposal: MealChatProposal
    let meal: MealDetail?
    let isLatest: Bool
    let isAccepting: Bool
    let onAccept: () -> Void
    let onEdit: () -> Void

    private var isAlreadyApplied: Bool {
        guard let meal, meal.trusted else { return false }
        return meal.macros.carbs.grams == proposal.carbs_g && meal.macros.protein.grams == proposal.protein_g && meal.macros.fat.grams == proposal.fat_g
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(proposal.items) { item in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.name)
                            .font(.subheadline)
                        Text([item.grams.map { "\(LoopFormat.number($0)) g" }, item.source == "DIABCALC" ? "DiabCalc" : "szacunek"].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(LoopFormat.number(item.carbs_g)) g W")
                        .font(.subheadline.monospacedDigit())
                }
            }
            Divider()
            HStack {
                Text("Razem")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("W \(LoopFormat.number(proposal.carbs_g)) · B \(LoopFormat.number(proposal.protein_g)) · T \(LoopFormat.number(proposal.fat_g)) g")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
            }
            Text("Pewność: \(Self.confidenceLabel(proposal.confidence))")
                .font(.caption)
                .foregroundStyle(.secondary)
            if !proposal.assumptions.isEmpty {
                Text(proposal.assumptions)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if isLatest {
                if isAlreadyApplied {
                    Label("Zatwierdzone", systemImage: "checkmark.seal.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.green)
                } else {
                    HStack {
                        Button(action: onAccept) {
                            if isAccepting {
                                ProgressView()
                            } else {
                                Text("Zatwierdź").fontWeight(.semibold)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(isAccepting)
                        Button("Popraw", action: onEdit)
                            .buttonStyle(.bordered)
                    }
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.secondary.opacity(0.08)))
    }

    static func confidenceLabel(_ value: String) -> String {
        switch value {
        case "HIGH": return "wysoka"
        case "MEDIUM": return "średnia"
        default: return "niska"
        }
    }
}

/// Edit of a meal: its description and its macros. Values prefilled from Nightscout are saved only when changed;
/// values prefilled from an AI proposal ("Popraw") are saved as the caregiver's.
struct MealEditSheet: View {
    /// The meal as shown now (it follows live updates); the save is based on the meal as it was when the sheet opened.
    let meal: MealDetail?
    let proposal: MealChatProposal?
    /// Saves the edit; `edit` comes back based on what was written, also when a later write failed.
    let onSave: (inout MealEdit) async -> MealEditOutcome

    @Environment(\.dismiss) private var dismiss
    @State private var description = ""
    @State private var carbs = ""
    @State private var protein = ""
    @State private var fat = ""
    @State private var initialValues: [String] = []
    @State private var isSaving = false
    @State private var openedRevision: Int?
    @State private var openedDescription: String?
    /// The revision the sheet opened with and every one this sheet wrote itself: none of them is the other caregiver's.
    @State private var ownRevisions: Set<Int> = []
    @State private var failure: MealEditOutcome?

    /// The other caregiver saved this meal while the sheet was open: saving now would be refused.
    private var changedMeanwhile: Bool {
        guard let current = meal?.content_revision, !ownRevisions.isEmpty else { return false }
        return !ownRevisions.contains(current)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Opis") {
                    TextField("Np. naleśniki z dżemem, szklanka kakao", text: $description, axis: .vertical)
                        .lineLimit(2...6)
                }
                Section {
                    field("Węglowodany", text: $carbs)
                    field("Białko", text: $protein)
                    field("Tłuszcz", text: $fat)
                } header: {
                    Text("Makroskładniki całego posiłku (g)")
                } footer: {
                    Text("Puste pole oznacza „nie wiem”. Zapisane wartości staną się zatwierdzonymi danymi posiłku. Wartości w Nightscout się nie zmieniają.")
                }
                if changedMeanwhile {
                    Section {
                        Label("Druga osoba właśnie zmieniła ten posiłek. Zamknij i otwórz edycję ponownie, żeby zobaczyć jej wersję.", systemImage: "person.2.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle(proposal == nil ? "Edytuj posiłek" : "Popraw propozycję")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zapisz") {
                        isSaving = true
                        var edit = MealEdit(
                            description: description,
                            carbs: Self.number(carbs),
                            protein: Self.number(protein),
                            fat: Self.number(fat),
                            saveValues: proposal != nil || [carbs, protein, fat] != initialValues,
                            baseRevision: openedRevision,
                            baseDescription: openedDescription
                        )
                        Task {
                            let outcome = await onSave(&edit)
                            // A partial save (the description written, the values not): a retry builds on it.
                            openedRevision = edit.baseRevision
                            openedDescription = edit.baseDescription
                            if let revision = edit.baseRevision { ownRevisions.insert(revision) }
                            isSaving = false
                            if case .saved = outcome {
                                dismiss()
                            } else {
                                failure = outcome
                            }
                        }
                    }
                    .disabled(isSaving)
                }
            }
            .onAppear(perform: fill)
            .alert(
                "Posiłek",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }),
                presenting: failure
            ) { outcome in
                Button("OK", role: .cancel) {
                    // The meal changed under the sheet: close it so the caregiver sees the current version.
                    if case .superseded = outcome { dismiss() }
                }
            } message: { outcome in
                Text(outcome.message ?? "")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("—", text: text)
                .multilineTextAlignment(.trailing)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
                .frame(maxWidth: 120)
            Text("g").foregroundStyle(.secondary)
        }
    }

    private func fill() {
        let value = { (grams: Double?) in grams.map { LoopFormat.number($0) } ?? "" }
        openedRevision = meal?.content_revision
        openedDescription = meal?.description
        ownRevisions = meal?.content_revision.map { [$0] } ?? []
        description = meal?.description ?? ""
        if let proposal {
            carbs = value(proposal.carbs_g)
            protein = value(proposal.protein_g)
            fat = value(proposal.fat_g)
        } else if let meal {
            carbs = value(meal.macros.carbs.grams ?? meal.source_carbs_g)
            protein = value(meal.macros.protein.grams)
            fat = value(meal.macros.fat.grams)
        }
        initialValues = [carbs, protein, fat]
    }

    static func number(_ text: String) -> Double? {
        let normalized = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let value = Double(normalized), value >= 0, value <= 1000 else { return nil }
        return value
    }
}

/// Photos sent to the server: at most 1280 px on the longer side, JPEG quality 0.7 (a few hundred kB).
public enum MealPhotoEncoder {
    #if canImport(UIKit)
    public static func jpeg(from image: UIImage, maxDimension: CGFloat = 1280) -> Data? {
        let largest = max(image.size.width, image.size.height)
        let scale = largest > maxDimension ? maxDimension / largest : 1
        let target = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: 0.7)
    }

    public static func jpeg(fromImageData data: Data) -> Data? {
        UIImage(data: data).flatMap { jpeg(from: $0) }
    }
    #else
    public static func jpeg(fromImageData data: Data) -> Data? {
        data
    }
    #endif
}

#if os(iOS)
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraPicker

        init(_ parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onImage(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
#endif
