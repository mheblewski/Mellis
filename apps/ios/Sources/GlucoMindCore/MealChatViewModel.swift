import Combine
import Foundation

@MainActor
public final class MealChatViewModel: ObservableObject {
    @Published public private(set) var chat: MealChatResponse?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSending = false
    @Published public private(set) var acceptingMessageID: String?
    @Published public private(set) var photoCache: [String: Data] = [:]
    @Published public var draft = ""
    /// JPEGs picked for the next message (at most 3).
    @Published public private(set) var draftPhotos: [Data] = []
    @Published public var errorMessage: String?

    public let route: MealRoute
    private let api: MealChatAPI
    private let pollIntervalNanoseconds: UInt64
    private let maxPolls: Int
    private var pollTask: Task<Void, Never>?
    /// The reply being written, as the live stream last reported it.
    @Published private var liveDraft: LiveReplyDraft?
    /// The last draft after the stream cleared it, shown until a read started after the clear settles it (the reply
    /// is stored a moment before its draft is cleared, but read a moment after).
    @Published private var lingeringDraft: (draft: LiveReplyDraft, clearedAt: Date)?
    private var liveUpdates: LiveUpdates?
    private var liveSubscriptions: Set<AnyCancellable> = []
    private var pendingLiveReload: Task<Void, Never>?
    private var pollPoked = false
    /// The upload of each draft photo (nil until uploaded), kept across a failed send: a resend does not upload again.
    private var draftPhotoUploadIDs: [String?] = []
    /// A send whose outcome is unknown; sending the same text and photos again reuses its idempotency key, so the
    /// server does not store the message (and pay for the reply) twice.
    private var failedSend: (content: String?, photoIDs: [String], idempotencyKey: String)?

    public init(route: MealRoute, api: MealChatAPI, pollIntervalNanoseconds: UInt64 = 2_500_000_000, maxPolls: Int = 60) {
        self.route = route
        self.api = api
        self.pollIntervalNanoseconds = pollIntervalNanoseconds
        self.maxPolls = maxPolls
    }

    deinit {
        pollTask?.cancel()
    }

    public var canSend: Bool {
        !isSending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftPhotos.isEmpty)
    }

    public var canAddPhoto: Bool {
        draftPhotos.count < 3
    }

    /// The newest AI proposal; older ones stay in the history but only this one is offered for acceptance.
    public var latestProposalMessageID: String? {
        chat?.messages.last(where: { $0.proposal != nil })?.id
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await api.getMealChat(patientID: route.patientID, mealID: route.mealID))
        } catch {
            errorMessage = "Nie udało się wczytać posiłku. Sprawdź połączenie i spróbuj ponownie."
        }
    }

    /// Re-reads the chat without the loading state (a live change); a failure keeps what is shown.
    public func reload() async {
        let readStartedAt = Date()
        if let response = try? await api.getMealChat(patientID: route.patientID, mealID: route.mealID) {
            apply(response)
            settleLingeringDraft(readStartedAt: readStartedAt)
        }
    }

    /// A read that started after the draft was cleared knows the outcome (stored reply or failed attempt).
    private func settleLingeringDraft(readStartedAt: Date) {
        guard let lingeringDraft else { return }
        if readStartedAt >= lingeringDraft.clearedAt || Date().timeIntervalSince(lingeringDraft.clearedAt) > 15 {
            self.lingeringDraft = nil
        }
    }

    /// Connects the chat to the patient's live updates: the other caregiver's messages and edits and the reply being
    /// written appear without polling. Without them the chat polls as before.
    public func bindLiveUpdates(_ live: LiveUpdates?) {
        guard live !== liveUpdates else { return }
        liveSubscriptions.removeAll()
        liveUpdates = live
        guard let live else {
            liveDraft = nil
            return
        }
        live.changes
            .sink { [weak self] change in self?.handleLiveChange(change) }
            .store(in: &liveSubscriptions)
        live.$drafts
            .sink { [weak self] drafts in
                guard let self else { return }
                let draft = drafts[ReplyDraftKey(thread: .mealChat, id: self.route.mealID)]
                guard draft != self.liveDraft else { return }
                if draft == nil, let cleared = self.liveDraft {
                    // Stored, failed or cancelled: the copy from the last read is stale; the cleared text stays on
                    // screen until the next read settles it.
                    self.chat?.reply_draft = nil
                    self.lingeringDraft = (cleared, Date())
                }
                if draft != nil {
                    self.lingeringDraft = nil
                }
                self.liveDraft = draft
            }
            .store(in: &liveSubscriptions)
    }

    /// The reply being written to the latest caregiver message, from the live stream or the last fetched chat.
    public var visibleReplyDraft: LiveReplyDraft? {
        guard let chat, chat.reply_pending,
              let draft = liveDraft ?? lingeringDraft?.draft ?? chat.reply_draft,
              !draft.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let lastUser = chat.messages.last(where: \.isFromCaregiver),
              lastUser.id.lowercased() == draft.reply_to_message_id.lowercased() else {
            return nil
        }
        return draft
    }

    private func handleLiveChange(_ change: LiveChange) {
        guard change.concerns(kind: "meal_chat", id: route.mealID) || change.concerns(kind: "meal", id: route.mealID) else { return }
        if pollTask != nil {
            pollPoked = true
            return
        }
        pendingLiveReload?.cancel()
        pendingLiveReload = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await self?.reload()
        }
    }

    /// While the live stream is up a poll only backs it up, so it waits longer; a live change wakes it at once.
    private var nextPollInterval: Duration {
        let base = Duration.nanoseconds(Int64(pollIntervalNanoseconds))
        return liveUpdates?.isLive == true ? max(base, .seconds(8)) : base
    }

    /// Waits for the next poll without holding the view model: false when it went away (sheet closed) or the poll was
    /// cancelled.
    private static func sleepUntilNextPoll(_ weakModel: WeakMealChatViewModel) async -> Bool {
        guard let interval = weakModel.model?.nextPollInterval else { return false }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: interval)
        while clock.now < deadline {
            if Task.isCancelled { return false }
            guard let model = weakModel.model else { return false }
            if model.pollPoked { break }
            try? await Task.sleep(for: min(.milliseconds(100), clock.now.duration(to: deadline)))
        }
        weakModel.model?.pollPoked = false
        return !Task.isCancelled && weakModel.model != nil
    }

    private static let staleWriteMessage = MealEditOutcome.supersededMessage

    public func addPhoto(_ jpeg: Data) {
        guard canAddPhoto else { return }
        draftPhotos.append(jpeg)
        draftPhotoUploadIDs.append(nil)
    }

    public func removeDraftPhoto(at index: Int) {
        guard draftPhotos.indices.contains(index) else { return }
        draftPhotos.remove(at: index)
        draftPhotoUploadIDs.remove(at: index)
    }

    /// The composer's mic: a voice message as text; nil (no mic) for a client without speech to text.
    public var voiceTranscribe: VoiceTranscribe? {
        guard let voiceAPI = api as? VoiceTranscriptionAPI else { return nil }
        let patientID = route.patientID
        return routedVoiceTranscribe(server: { audio in
            try await voiceAPI.transcribeVoice(patientID: patientID, m4aData: audio).text
        })
    }

    public func send() async {
        guard canSend else { return }
        isSending = true
        defer { isSending = false }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = text.isEmpty ? nil : text
        let photos = draftPhotos
        var photoIDs: [String] = []
        do {
            for (index, photo) in photos.enumerated() {
                if let uploadedID = draftPhotoUploadIDs[index] {
                    photoIDs.append(uploadedID)
                    continue
                }
                let uploaded = try await api.uploadMealPhoto(patientID: route.patientID, mealID: route.mealID, jpegData: photo)
                photoIDs.append(uploaded.photo_id)
                photoCache[uploaded.photo_id] = photo
                if draftPhotos == photos {
                    draftPhotoUploadIDs[index] = uploaded.photo_id
                }
            }
        } catch {
            errorMessage = "Nie udało się wysłać wiadomości. Sprawdź połączenie i spróbuj ponownie."
            return
        }
        // The unchanged text and photos of a failed send are the same request: keep its idempotency key.
        let idempotencyKey: String
        if let failedSend, failedSend.content == content, failedSend.photoIDs == photoIDs {
            idempotencyKey = failedSend.idempotencyKey
        } else {
            idempotencyKey = UUID().uuidString.lowercased()
        }
        do {
            let response = try await api.postMealChat(
                patientID: route.patientID,
                mealID: route.mealID,
                content: content,
                photoIDs: photoIDs,
                idempotencyKey: idempotencyKey
            )
            failedSend = nil
            draft = ""
            draftPhotos = []
            draftPhotoUploadIDs = []
            apply(response)
        } catch {
            failedSend = (content, photoIDs, idempotencyKey)
            errorMessage = "Nie udało się wysłać wiadomości. Sprawdź połączenie i spróbuj ponownie."
        }
    }

    /// Asks the AI again after a failed reply.
    public func retry() async {
        do {
            apply(try await api.retryMealChatReply(patientID: route.patientID, mealID: route.mealID))
        } catch {
            errorMessage = "Nie udało się ponowić. Sprawdź połączenie i spróbuj jeszcze raz."
        }
    }

    public func accept(messageID: String) async {
        acceptingMessageID = messageID
        defer { acceptingMessageID = nil }
        do {
            apply(try await api.acceptMealChatProposal(patientID: route.patientID, mealID: route.mealID, messageID: messageID, expectedRevision: chat?.meal.content_revision))
        } catch where error.isStaleWrite {
            errorMessage = Self.staleWriteMessage
            await reload()
        } catch {
            errorMessage = "Nie udało się zatwierdzić propozycji. Spróbuj ponownie."
        }
    }

    /// Saves an edit of the meal: the description when it changed, the values when any is given (empty = "unknown").
    public func saveEdit(_ edit: inout MealEdit) async -> MealEditOutcome {
        do {
            try await MealEdit.apply(&edit, to: chat?.meal, api: api, route: route)
            await load()
            return .saved
        } catch {
            let outcome = MealEditOutcome(error: error)
            if case .superseded = outcome { await reload() }
            return outcome
        }
    }

    public func photo(_ photoID: String) async -> Data? {
        if let cached = photoCache[photoID] {
            return cached
        }
        guard let data = try? await api.mealPhotoData(patientID: route.patientID, mealID: route.mealID, photoID: photoID) else {
            return nil
        }
        photoCache[photoID] = data
        return data
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func apply(_ response: MealChatResponse) {
        chat = response
        if response.reply_pending {
            startPolling()
        } else {
            stopPolling()
        }
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        let maxPolls = self.maxPolls
        let weakModel = WeakMealChatViewModel(self)
        pollTask = Task {
            for _ in 0..<maxPolls {
                // The view model is held only during a read: a sheet closed by a swipe lets it go and the polling ends.
                guard await Self.sleepUntilNextPoll(weakModel), let model = weakModel.model else { return }
                guard let replyPending = await model.pollOnce() else { return }
                if !replyPending { break }
            }
            // A cancelled poll leaves `pollTask` alone: it may already be a newer one.
            if !Task.isCancelled {
                weakModel.model?.pollTask = nil
            }
        }
    }

    /// One read of the chat while the reply is pending: whether it still is (nil when cancelled meanwhile).
    private func pollOnce() async -> Bool? {
        let readStartedAt = Date()
        guard let response = try? await api.getMealChat(patientID: route.patientID, mealID: route.mealID) else {
            return Task.isCancelled ? nil : true
        }
        if Task.isCancelled { return nil }
        chat = response
        settleLingeringDraft(readStartedAt: readStartedAt)
        return response.reply_pending
    }
}

/// The meal chat seen from its polling task, without keeping it alive.
private final class WeakMealChatViewModel: @unchecked Sendable {
    weak var model: MealChatViewModel?

    init(_ model: MealChatViewModel) {
        self.model = model
    }
}

public struct MealEdit: Equatable {
    public var description: String
    public var carbs: Double?
    public var protein: Double?
    public var fat: Double?
    /// True when the caregiver changed a value or is saving an AI proposal; untouched prefilled values are not saved.
    public var saveValues: Bool
    /// The meal's content revision and description when the edit was opened; the save is refused when the other
    /// caregiver saved since. nil: taken from the meal passed to `apply`.
    public var baseRevision: Int?
    public var baseDescription: String?

    public init(description: String, carbs: Double?, protein: Double?, fat: Double?, saveValues: Bool, baseRevision: Int? = nil, baseDescription: String? = nil) {
        self.description = description
        self.carbs = carbs
        self.protein = protein
        self.fat = fat
        self.saveValues = saveValues
        self.baseRevision = baseRevision
        self.baseDescription = baseDescription
    }

    /// Writes only what changed: the description (PUT description) and/or the values (caregiver correction). The first
    /// write names the meal revision the sheet was opened with, the second the revision the first one returned, so a
    /// save over the other caregiver's newer description or values is refused (STALE_WRITE) instead of overwriting it.
    /// After each write `edit` is based on it: a retry after the second write failed builds on this phone's own first one.
    public static func apply(_ edit: inout MealEdit, to meal: MealDetail?, api: MealChatAPI, route: MealRoute) async throws {
        let description = edit.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let descriptionChanged = !description.isEmpty && description != (edit.baseDescription ?? meal?.description ?? "")
        let hasValues = edit.carbs != nil || edit.protein != nil || edit.fat != nil
        if description.isEmpty && !hasValues {
            throw MealEditError.nothingToSave
        }
        edit.baseRevision = edit.baseRevision ?? meal?.content_revision
        edit.baseDescription = edit.baseDescription ?? meal?.description
        if descriptionChanged {
            let saved = try await api.updateMealDescription(patientID: route.patientID, mealID: route.mealID, description: description, expectedRevision: edit.baseRevision)
            edit.baseRevision = saved.meal.content_revision
            edit.baseDescription = description
        }
        if edit.saveValues && hasValues {
            let saved = try await api.correctMeal(patientID: route.patientID, mealID: route.mealID, carbsG: edit.carbs, proteinG: edit.protein, fatG: edit.fat, expectedRevision: edit.baseRevision)
            edit.baseRevision = saved.meal.content_revision
        }
    }

    public static func apply(_ edit: MealEdit, to meal: MealDetail?, api: MealChatAPI, route: MealRoute) async throws {
        var edit = edit
        try await apply(&edit, to: meal, api: api, route: route)
    }
}

public enum MealEditError: Error {
    case nothingToSave
}

/// How a meal edit ended, for the edit sheet: saved (it closes), failed (it stays open with the message) or
/// superseded by the other caregiver's save (the message, then it closes so the current version is shown).
public enum MealEditOutcome: Equatable {
    case saved
    case failed(String)
    case superseded(String)

    public var message: String? {
        switch self {
        case .saved: return nil
        case let .failed(message), let .superseded(message): return message
        }
    }

    public static let supersededMessage = "Ten posiłek właśnie zmieniła druga osoba. Pokazuję aktualną wersję — sprawdź ją i zapisz ponownie, jeśli trzeba."

    public init(error: Error) {
        if case MealEditError.nothingToSave = error {
            self = .failed("Wpisz opis albo co najmniej jedną wartość.")
        } else if error.isStaleWrite {
            self = .superseded(Self.supersededMessage)
        } else {
            self = .failed("Nie udało się zapisać zmian. Spróbuj ponownie.")
        }
    }
}
