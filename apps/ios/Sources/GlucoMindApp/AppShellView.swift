import Combine
import SwiftUI
import GlucoMindCore
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

@MainActor
final class AppShellViewModel: ObservableObject {
    @Published private(set) var historySections: [ConversationHistorySection] = []
    @Published private(set) var pendingQuestions: [PendingQuestionListItem] = []
    @Published private(set) var pendingConversationID: String?
    @Published private(set) var isLoadingHistory = false
    @Published private(set) var isCreatingConversation = false
    @Published private(set) var historyError: String?

    private let apiClient: APIClient
    private let patientID: String
    private var liveSubscription: AnyCancellable?

    init(apiClient: APIClient, patientID: String) {
        self.apiClient = apiClient
        self.patientID = patientID
    }

    /// New, renamed, pinned or deleted conversations (either caregiver, or a hypo) appear in the history. Held here,
    /// not in the view: a view's onReceive is re-subscribed on every render and would drop a debounced change.
    func bindLiveUpdates(_ live: LiveUpdates?) {
        liveSubscription = live?.changes
            .filter { $0.concerns(anyOf: ["conversation", "hypo"]) }
            .debounce(for: .seconds(1), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.refreshData() }
            }
    }

    /// Grows with every refresh: only the latest one writes (an older, slower answer could bring back a deleted
    /// conversation) and only the latest one ends the loading state.
    private var refreshGeneration = 0
    /// A history list was read at least once (a cancelled first refresh leaves it unread).
    private var hasReadHistory = false
    /// Older refreshes waiting for the newest one, so their callers read the newest lists.
    private var newestRefreshWaiters: [CheckedContinuation<Void, Never>] = []

    func refreshData() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        isLoadingHistory = true
        defer {
            if generation == refreshGeneration {
                isLoadingHistory = false
                let waiters = newestRefreshWaiters
                newestRefreshWaiters = []
                waiters.forEach { $0.resume() }
            }
        }

        async let pendingTask = apiClient.getPendingInvestigation(patientID: patientID)
        async let pendingQuestionsTask = apiClient.listPendingQuestions(patientID: patientID)
        async let historyTask = apiClient.listConversations(patientID: patientID, limit: 100, cursor: nil)

        let pending: Result<PendingInvestigationResponse, Error>
        do { pending = .success(try await pendingTask) } catch { pending = .failure(error) }
        let questions: Result<PendingQuestionsListResponse, Error>
        do { questions = .success(try await pendingQuestionsTask) } catch { questions = .failure(error) }
        let history: Result<ConversationsListResponse, Error>
        do { history = .success(try await historyTask) } catch { history = .failure(error) }

        guard generation == refreshGeneration else {
            // A newer refresh started meanwhile: its answer wins, and this caller returns once it is in.
            if isLoadingHistory {
                await withCheckedContinuation { newestRefreshWaiters.append($0) }
            }
            return
        }
        // A cancelled request (the screen went away, a pull gesture ended) is not a failure: what is shown stays.
        func isCancellation(_ error: Error) -> Bool { error.isRequestCancellation || Task.isCancelled }

        switch pending {
        case .success(let response):
            pendingConversationID = response.pending_investigation?.conversation_id
        case .failure(let error) where !isCancellation(error):
            pendingConversationID = nil
        case .failure:
            break
        }

        switch questions {
        case .success(let response):
            pendingQuestions = response.items.filter(Self.isSystemInitiatedPendingQuestion)
        case .failure(let error) where !isCancellation(error):
            pendingQuestions = []
        case .failure:
            break
        }

        switch history {
        case .success(let response):
            let pendingConversationIDs = Set(pendingQuestions.map(\.conversation_id))
            let items = ConversationListHistoryAdapter
                .makeItems(from: response.items)
                .filter { !pendingConversationIDs.contains($0.conversationID) }
            // Statuses come with the list itself (activity_status): no request per conversation.
            historySections = ConversationHistoryGrouper.sections(from: items)
            historyError = nil
            hasReadHistory = true
        case .failure(let error) where !isCancellation(error):
            historyError = "Nie udało się wczytać historii rozmów"
            historySections = []
        case .failure:
            break
        }
    }

    private static func isSystemInitiatedPendingQuestion(_ question: PendingQuestionListItem) -> Bool {
        if let origin = question.origin?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(), origin == "SYSTEM" {
            return true
        }

        if let conversationType = question.conversation_type?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(), conversationType == "TRIGGER_INITIATED" {
            return true
        }

        return false
    }

    func createConversation() async throws -> String {
        try await createNewConversation().id
    }

    /// The new conversation as the server returned it, so the chat can show it without reading it again.
    func createNewConversation() async throws -> ConversationResponse {
        guard !isCreatingConversation else {
            throw AppShellViewModelError.conversationCreationInProgress
        }

        isCreatingConversation = true
        defer {
            isCreatingConversation = false
        }

        let response = try await apiClient.createConversation(
            patientID: patientID,
            idempotencyKey: UUID().uuidString.lowercased()
        )

        await refreshData()
        return response.conversation
    }

    /// Removes the conversation for both caregivers, then reloads the history.
    func deleteConversation(_ conversationID: String) async throws {
        try await apiClient.deleteConversation(patientID: patientID, conversationID: conversationID)
        await refreshData()
    }

    /// Renames the conversation for both caregivers (the AI never replaces this name), then reloads the history.
    func renameConversation(_ conversationID: String, to title: String) async throws {
        try await apiClient.updateConversation(patientID: patientID, conversationID: conversationID, title: title)
        await refreshData()
    }

    /// Pins the conversation to the top of the history (or unpins it) for both caregivers, then reloads the history.
    func setConversationPinned(_ conversationID: String, pinned: Bool) async throws {
        try await apiClient.updateConversation(patientID: patientID, conversationID: conversationID, pinned: pinned)
        await refreshData()
    }

    /// The most recent conversation (opened at start and after a delete); pinned ones only when nothing else is left.
    var firstConversationID: String? {
        let recent = historySections.first { $0.key != .pinned } ?? historySections.first
        return recent?.entries.first?.conversationID
    }

    var allConversationIDs: Set<String> {
        Set(historySections.flatMap { section in
            section.entries.map(\.conversationID)
        })
    }

    /// Every conversation the lists know: the history and the waiting questions (which the history leaves out).
    var knownConversationIDs: Set<String> {
        allConversationIDs
            .union(pendingQuestions.map(\.conversation_id))
            .union([pendingConversationID].compactMap { $0 })
    }

    /// The history was read (an error or a cancelled request says nothing about which conversations exist).
    var isHistoryLoaded: Bool {
        hasReadHistory && historyError == nil && !isLoadingHistory
    }
}

enum AppShellViewModelError: Error {
    case conversationCreationInProgress
}

struct PendingQuestionsPresentationState {
    var isExpanded = false
    private var knownQuestionIDs: Set<String> = []

    mutating func toggle() {
        isExpanded.toggle()
    }

    /// Expands whenever a question appears that was not listed before, so a new question is visible without an
    /// extra tap. A collapse by the user is kept until another new question arrives.
    mutating func reconcile(with questions: [PendingQuestionListItem]) {
        let ids = Set(questions.map(\.id))
        if !ids.subtracting(knownQuestionIDs).isEmpty {
            isExpanded = true
        }
        knownQuestionIDs = ids
    }

    func visibleQuestions(from questions: [PendingQuestionListItem]) -> [PendingQuestionListItem] {
        isExpanded ? questions : []
    }
}

/// The conversation the tab shows when it appears: the one already chosen (by the caregiver or a notification) stays;
/// otherwise the question waiting for an answer, then the most recent one.
enum ConversationSelectionResolver {
    /// `openedFromNotification`: shown even when the lists do not have it (an old conversation from the bell; a deleted
    /// one shows its error instead of another conversation). `historyLoaded`: false after a failed or cancelled read,
    /// which says nothing about which conversations exist.
    static func resolve(
        selectedConversationID: String?,
        openedFromNotification: String?,
        knownConversationIDs: Set<String>,
        historyLoaded: Bool,
        pendingConversationID: String?,
        firstConversationID: String?
    ) -> String? {
        if let selectedConversationID,
           selectedConversationID == openedFromNotification
            || knownConversationIDs.contains(selectedConversationID)
            || !historyLoaded {
            return selectedConversationID
        }

        return pendingConversationID ?? firstConversationID
    }
}

struct AppShellView: View {
    let patient: AccessiblePatient
    let apiClient: APIClient
    let selectedConversationID: String?
    let selectedConversationRefreshNonce: Int
    /// The conversation a notification opened (shown even when the history does not list it).
    let openedFromNotification: String?
    let onSelectConversation: (_ conversationID: String, _ triggerRefreshIfSame: Bool) -> Void
    /// The tab's own choice when it appears; applied only while the selection is still `seen` (a notification or the
    /// caregiver may have chosen another conversation meanwhile).
    let onSelectDefaultConversation: (_ conversationID: String, _ seen: String?) -> Void
    let onShowPatientSelection: () -> Void
    let onOpenNotification: (_ pushUserInfo: [AnyHashable: Any]) -> Void
    let onSignOut: () async -> Void
    /// Opens a meal in the meals tab (a saved meal change card in a conversation).
    var onOpenMeal: ((String) -> Void)? = nil
    /// Sends bolus cards; nil when this caregiver cannot send remote commands (the cards then have no button).
    var remoteBolusFlow: RemoteBolusFlow? = nil
    /// Changes when "Zapytaj w czacie" was tapped (Bolus tab, a meal's page): a new, empty conversation.
    var newChatRequest: UUID? = nil
    /// Tells the app the request was taken, so it opens one new conversation, once.
    var onNewChatHandled: (UUID) -> Void = { _ in }
    /// The caregiver's name for the greeting of an empty new conversation.
    var greetingName: String? = nil

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveUpdates) private var liveUpdates
    @StateObject private var shellViewModel: AppShellViewModel
    @StateObject private var conversationViewModel: ConversationViewModel
    @State private var isDrawerPresented = false
    /// No conversation is open yet because the tab is still choosing one (it has just opened, or a new one is being
    /// created for an account without any): the chat shows nothing instead of "no conversation".
    @State private var isChoosingConversation = true
    @State private var creationError: String?
    @State private var deletionError: String?
    @State private var historyActionError: String?

    init(
        patient: AccessiblePatient,
        apiClient: APIClient,
        selectedConversationID: String?,
        selectedConversationRefreshNonce: Int,
        openedFromNotification: String?,
        onSelectConversation: @escaping (_ conversationID: String, _ triggerRefreshIfSame: Bool) -> Void,
        onSelectDefaultConversation: @escaping (_ conversationID: String, _ seen: String?) -> Void,
        onShowPatientSelection: @escaping () -> Void,
        onOpenNotification: @escaping (_ pushUserInfo: [AnyHashable: Any]) -> Void,
        onSignOut: @escaping () async -> Void,
        onOpenMeal: ((String) -> Void)? = nil,
        remoteBolusFlow: RemoteBolusFlow? = nil,
        newChatRequest: UUID? = nil,
        onNewChatHandled: @escaping (UUID) -> Void = { _ in },
        greetingName: String? = nil
    ) {
        self.newChatRequest = newChatRequest
        self.onNewChatHandled = onNewChatHandled
        self.remoteBolusFlow = remoteBolusFlow
        self.greetingName = greetingName
        self.patient = patient
        self.apiClient = apiClient
        self.selectedConversationID = selectedConversationID
        self.selectedConversationRefreshNonce = selectedConversationRefreshNonce
        self.openedFromNotification = openedFromNotification
        self.onSelectConversation = onSelectConversation
        self.onSelectDefaultConversation = onSelectDefaultConversation
        self.onShowPatientSelection = onShowPatientSelection
        self.onOpenNotification = onOpenNotification
        self.onSignOut = onSignOut
        self.onOpenMeal = onOpenMeal
        _shellViewModel = StateObject(wrappedValue: AppShellViewModel(apiClient: apiClient, patientID: patient.patient_id))
        _conversationViewModel = StateObject(wrappedValue: ConversationViewModel(apiClient: apiClient, patientID: patient.patient_id))
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                NavigationStack {
                    ConversationView(
                        viewModel: conversationViewModel,
                        conversationID: selectedConversationID,
                        refreshNonce: selectedConversationRefreshNonce,
                        onStartNewConversation: startNewConversation,
                        isStartingNewConversation: shellViewModel.isCreatingConversation,
                        onOpenMeal: onOpenMeal,
                        onGiveBolus: remoteBolusFlow.map { flow in
                            { base in
                                Task { await flow.prepare(base) }
                            }
                        },
                        greetingName: greetingName,
                        isChoosingConversation: isChoosingConversation && selectedConversationID == nil
                    )
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        topBar
                    }
                    #endif
                    .modifier(OptionalRemoteBolusConfirmation(flow: remoteBolusFlow))
                    // A card refused as expired: read again, so it shows "Przelicz na aktualnych danych".
                    .onReceive(remoteBolusFlow?.proposalExpired.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
                        Task { await conversationViewModel.refreshActiveConversation() }
                    }
                    .onChange(of: newChatRequest) { _, _ in
                        takeNewChatRequest()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if isDrawerPresented {
                    Color.black.opacity(0.25)
                        .ignoresSafeArea()
                        .onTapGesture {
                            withAnimation(.easeOut(duration: 0.22)) {
                                isDrawerPresented = false
                            }
                        }

                    ConversationHistoryDrawer(
                        sections: shellViewModel.historySections,
                        pendingQuestions: shellViewModel.pendingQuestions,
                        selectedConversationID: selectedConversationID,
                        isLoading: shellViewModel.isLoadingHistory,
                        isCreatingConversation: shellViewModel.isCreatingConversation,
                        errorMessage: shellViewModel.historyError,
                        onCreateConversation: startNewConversation,
                        onRetry: {
                            Task {
                                await shellViewModel.refreshData()
                            }
                        },
                        onSelectConversation: { conversationID in
                            withAnimation(.easeOut(duration: 0.22)) {
                                isDrawerPresented = false
                            }
                            onSelectConversation(conversationID, true)
                        },
                        onDeleteConversation: deleteConversation,
                        onRenameConversation: renameConversation,
                        onSetConversationPinned: setConversationPinned,
                        onClose: {
                            withAnimation(.easeOut(duration: 0.22)) {
                                isDrawerPresented = false
                            }
                        }
                    )
                    .frame(width: min(geometry.size.width * 0.82, 340), height: geometry.size.height)
                    .transition(.move(edge: .leading))
                }
            }
            .task(id: patient.patient_id) {
                isChoosingConversation = true
                if await !bootstrapSelection() {
                    isChoosingConversation = false
                }
            }
            .onChange(of: selectedConversationID) { _, conversationID in
                // The choice has arrived; a conversation closed later (deleted) shows "no conversation".
                if conversationID != nil {
                    isChoosingConversation = false
                }
            }
            .alert(
                "Nie udało się rozpocząć rozmowy",
                isPresented: Binding(get: { creationError != nil }, set: { if !$0 { creationError = nil } })
            ) {
                Button("Spróbuj ponownie") {
                    startNewConversation()
                }
                Button("Anuluj", role: .cancel) {}
            } message: {
                Text(creationError ?? "")
            }
            .alert(
                "Nie udało się usunąć rozmowy",
                isPresented: Binding(get: { deletionError != nil }, set: { if !$0 { deletionError = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deletionError ?? "")
            }
            .alert(
                "Nie udało się zapisać zmiany",
                isPresented: Binding(get: { historyActionError != nil }, set: { if !$0 { historyActionError = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(historyActionError ?? "")
            }
            // A notification opens its conversation over the history drawer.
            .closesForNotification(isPresented: isDrawerPresented) {
                isDrawerPresented = false
            }
            .onChange(of: scenePhase) { _, newValue in
                guard newValue == .active else {
                    return
                }

                Task {
                    await shellViewModel.refreshData()
                    await conversationViewModel.refreshActiveConversation()
                }
            }
            .task(id: liveUpdates.map(ObjectIdentifier.init)) {
                shellViewModel.bindLiveUpdates(liveUpdates)
            }
        }
    }

    /// Left: history and a new chat; middle: the patient; right: the same bell and settings as on the meals tab.
    #if os(iOS)
    @ToolbarContentBuilder
    private var topBar: some ToolbarContent {
        // One item, not a group: the two icons sit as close together as the bell and the gear on the right.
        ToolbarItem(placement: .topBarLeading) {
            HStack(spacing: 4) {
                Button {
                    withAnimation(.easeOut(duration: 0.22)) {
                        isDrawerPresented.toggle()
                    }
                    if isDrawerPresented {
                        // One list request; statuses are a snapshot of this moment.
                        Task {
                            await shellViewModel.refreshData()
                        }
                    }
                } label: {
                    Image(systemName: "line.3.horizontal")
                        .topBarIcon()
                        .overlay(alignment: .topTrailing) {
                            // Visible without opening the history: a question is waiting for an answer.
                            if !shellViewModel.pendingQuestions.isEmpty {
                                Text("\(shellViewModel.pendingQuestions.count)")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 5)
                                    .frame(minWidth: 16, minHeight: 16)
                                    .background(Capsule().fill(Color.red))
                                    .offset(x: 4, y: -2)
                            }
                        }
                }
                .accessibilityLabel("Historia rozmów")
                .accessibilityValue(shellViewModel.pendingQuestions.isEmpty ? "" : "Pytania czekające na odpowiedź: \(shellViewModel.pendingQuestions.count)")

                Button(action: startNewConversation) {
                    Image(systemName: "square.and.pencil")
                        .topBarIcon()
                }
                .disabled(shellViewModel.isCreatingConversation)
                .accessibilityLabel("Nowa rozmowa")
            }
        }

        ToolbarItem(placement: .principal) {
            PatientNameBubble(name: patient.display_name)
        }

        if let pendingConversationID = shellViewModel.pendingConversationID,
           pendingConversationID != selectedConversationID {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    onSelectConversation(pendingConversationID, true)
                } label: {
                    Image(systemName: "questionmark.bubble")
                        .topBarIcon()
                }
                .accessibilityLabel("Pytanie")
                .accessibilityHint("Otwiera rozmowę, która czeka na Twoją odpowiedź")
            }
        }

        ToolbarItem(placement: .topBarTrailing) {
            TopBarTrailingControls(
                apiClient: apiClient,
                patientID: patient.patient_id,
                onRefresh: {
                    Task {
                        await shellViewModel.refreshData()
                        await conversationViewModel.refreshActiveConversation()
                    }
                },
                onShowPatientSelection: onShowPatientSelection,
                onOpenNotification: onOpenNotification,
                onSignOut: onSignOut
            )
        }
    }
    #endif

    /// After deleting the open conversation, the most recent remaining one opens (or a new one when none is left).
    private func deleteConversation(_ conversationID: String) {
        Task {
            do {
                try await shellViewModel.deleteConversation(conversationID)
                guard selectedConversationID == conversationID else {
                    return
                }
                if let next = shellViewModel.firstConversationID {
                    onSelectConversation(next, true)
                } else {
                    startNewConversation()
                }
            } catch {
                deletionError = "Nie udało się usunąć rozmowy. Sprawdź połączenie i spróbuj ponownie."
            }
        }
    }

    private func renameConversation(_ conversationID: String, title: String) {
        Task {
            do {
                try await shellViewModel.renameConversation(conversationID, to: title)
            } catch {
                historyActionError = "Nie udało się zmienić nazwy rozmowy. Sprawdź połączenie i spróbuj ponownie."
            }
        }
    }

    private func setConversationPinned(_ conversationID: String, pinned: Bool) {
        Task {
            do {
                try await shellViewModel.setConversationPinned(conversationID, pinned: pinned)
            } catch {
                historyActionError = pinned
                    ? "Nie udało się przypiąć rozmowy. Sprawdź połączenie i spróbuj ponownie."
                    : "Nie udało się odpiąć rozmowy. Sprawdź połączenie i spróbuj ponownie."
            }
        }
    }

    /// The previous conversation and its unsent draft stay intact; the new one opens once the server created it (which
    /// also reads the history again).
    private func startNewConversation() {
        Task {
            do {
                let created = try await shellViewModel.createNewConversation()
                // Shown at once: no "Wczytuję rozmowę…" between the previous conversation and the new one.
                conversationViewModel.preloadCreatedConversation(created)
                onSelectConversation(created.id, true)
                withAnimation(.easeOut(duration: 0.22)) {
                    isDrawerPresented = false
                }
            } catch AppShellViewModelError.conversationCreationInProgress {
                // Ignore repeated taps while creation is already running.
            } catch {
                creationError = "Sprawdź połączenie i spróbuj ponownie. Obecna rozmowa pozostała bez zmian."
                // Nothing is on its way any more: without a conversation the chat offers "Nowa rozmowa".
                isChoosingConversation = false
                // A new chat asked for before the tab existed skipped the first read of the history: the drawer still
                // gets its conversations.
                if !shellViewModel.isHistoryLoaded { await shellViewModel.refreshData() }
            }
        }
    }

    /// "Zapytaj w czacie" waiting for this tab: a new, empty conversation instead of the last one (its creation reads
    /// the history too).
    @discardableResult
    private func takeNewChatRequest() -> Bool {
        guard let request = newChatRequest else { return false }
        onNewChatHandled(request)
        startNewConversation()
        return true
    }

    /// The selection this task saw is captured before the lists are read: a conversation chosen meanwhile (a
    /// notification, a tap) is never replaced by this default.
    /// True when a conversation is on its way: chosen here, created here for an account without any, or already open.
    func bootstrapSelection() async -> Bool {
        let seen = selectedConversationID
        // The tab is created only when it is first shown: a "Zapytaj w czacie" made before it existed waits here.
        if takeNewChatRequest() { return true }
        await shellViewModel.refreshData()
        guard !Task.isCancelled else { return seen != nil }

        let conversationID = ConversationSelectionResolver.resolve(
            selectedConversationID: seen,
            openedFromNotification: openedFromNotification,
            knownConversationIDs: shellViewModel.knownConversationIDs,
            historyLoaded: shellViewModel.isHistoryLoaded,
            pendingConversationID: shellViewModel.pendingConversationID,
            firstConversationID: shellViewModel.firstConversationID
        )

        if let conversationID, conversationID != seen {
            onSelectDefaultConversation(conversationID, seen)
            return true
        }
        if conversationID == nil, seen == nil, shellViewModel.isHistoryLoaded {
            // No conversation at all yet: a new one opens with its starter cards.
            startNewConversation()
            return true
        }
        return conversationID != nil
    }
}

struct ConversationHistoryDrawer: View {
    let sections: [ConversationHistorySection]
    let pendingQuestions: [PendingQuestionListItem]
    let selectedConversationID: String?
    let isLoading: Bool
    let isCreatingConversation: Bool
    let errorMessage: String?
    let onCreateConversation: () -> Void
    let onRetry: () -> Void
    let onSelectConversation: (String) -> Void
    let onDeleteConversation: (String) -> Void
    let onRenameConversation: (_ conversationID: String, _ title: String) -> Void
    let onSetConversationPinned: (_ conversationID: String, _ pinned: Bool) -> Void
    let onClose: () -> Void
    @State private var pendingQuestionsPresentation = PendingQuestionsPresentationState()
    @State private var conversationPendingDeletion: ConversationHistoryItem?
    @State private var conversationBeingRenamed: ConversationHistoryItem?
    @State private var renameDraft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Rozmowy")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Spacer()

                Button("Zamknij") {
                    onClose()
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Button {
                onCreateConversation()
            } label: {
                HStack(spacing: 10) {
                    if isCreatingConversation {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "square.and.pencil")
                    }
                    Text("Nowa rozmowa")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.accentColor.opacity(0.12))
                )
                .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
            .disabled(isCreatingConversation)
            .padding(.horizontal, 8)
            .padding(.bottom, 10)

            Divider()

            if isLoading && sections.isEmpty && pendingQuestions.isEmpty {
                ProgressView("Wczytuję…")
                    .frame(maxWidth: .infinity)
                    .padding(16)
            } else if let errorMessage {
                VStack(alignment: .leading, spacing: 8) {
                    Text(errorMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button("Spróbuj ponownie", action: onRetry)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                .padding(16)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if !pendingQuestions.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Button {
                                    withAnimation(.easeOut(duration: 0.2)) {
                                        pendingQuestionsPresentation.toggle()
                                    }
                                } label: {
                                    HStack(alignment: .center, spacing: 8) {
                                        SectionHeader(title: "Czekają na odpowiedź")
                                        Badge(text: String(pendingQuestions.count))
                                        Spacer()
                                        Image(systemName: pendingQuestionsPresentation.isExpanded ? "chevron.down" : "chevron.right")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(.secondary)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .padding(.horizontal, 16)
                                .accessibilityLabel("Czekają na odpowiedź, \(pendingQuestions.count)")
                                .accessibilityValue(pendingQuestionsPresentation.isExpanded ? "Rozwinięte" : "Zwinięte")

                                ForEach(pendingQuestionsPresentation.visibleQuestions(from: pendingQuestions)) { question in
                                    PendingQuestionRow(
                                        question: question,
                                        isSelected: selectedConversationID == question.conversation_id
                                    ) {
                                        onSelectConversation(question.conversation_id)
                                    }
                                }
                            }
                        }

                        if sections.isEmpty {
                            Text("Nie masz jeszcze żadnych rozmów.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 16)
                        } else {
                            ForEach(sections) { section in
                                VStack(alignment: .leading, spacing: 2) {
                                    SectionHeader(title: section.title)
                                        .padding(.horizontal, 16)
                                        .padding(.bottom, 2)

                                    ForEach(section.entries) { entry in
                                        ConversationHistoryRow(
                                            entry: entry,
                                            isSelected: selectedConversationID == entry.conversationID,
                                            showsDate: section.key.mixesDays,
                                            onTap: {
                                                onSelectConversation(entry.conversationID)
                                            },
                                            actions: {
                                                conversationActions(for: entry)
                                            }
                                        )
                                        .contextMenu {
                                            conversationActions(for: entry)
                                        }
                                        // On the row, not the drawer: on iPhone it opens as a bubble pointing at its view.
                                        .confirmationDialog(
                                            "Usunąć tę rozmowę?",
                                            isPresented: Binding(
                                                get: { conversationPendingDeletion?.conversationID == entry.conversationID },
                                                set: { if !$0 { conversationPendingDeletion = nil } }
                                            ),
                                            titleVisibility: .visible
                                        ) {
                                            Button("Usuń rozmowę", role: .destructive) {
                                                onDeleteConversation(entry.conversationID)
                                            }
                                            Button("Anuluj", role: .cancel) {}
                                        } message: {
                                            Text("Rozmowa zniknie u wszystkich opiekunów. Odpowiedzi na pytania o posiłki i hipoglikemie zostaną zachowane w danych pacjenta.")
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .padding(.vertical, 12)
                }
            }

            Spacer(minLength: 0)
        }
        .background(Color.shellChromeSurface)
        .alert(
            "Zmień nazwę",
            isPresented: Binding(
                get: { conversationBeingRenamed != nil },
                set: { if !$0 { conversationBeingRenamed = nil } }
            ),
            presenting: conversationBeingRenamed
        ) { entry in
            TextField("Nazwa rozmowy", text: $renameDraft)
            Button("Zapisz") {
                if let title = ConversationTitleDraft.normalized(renameDraft), title != entry.title {
                    onRenameConversation(entry.conversationID, title)
                }
            }
            Button("Anuluj", role: .cancel) {}
        } message: { _ in
            Text("Nowa nazwa będzie widoczna u wszystkich opiekunów.")
        }
        .onAppear {
            pendingQuestionsPresentation.reconcile(with: pendingQuestions)
        }
        .onChange(of: pendingQuestions.map(\.id)) { _, _ in
            pendingQuestionsPresentation.reconcile(with: pendingQuestions)
        }
    }
}

private extension ConversationHistoryDrawer {
    /// The same actions behind the row's ⋯ button and its long press.
    @ViewBuilder
    func conversationActions(for entry: ConversationHistoryItem) -> some View {
        Button {
            renameDraft = entry.title
            conversationBeingRenamed = entry
        } label: {
            Label("Zmień nazwę", systemImage: "pencil")
        }

        Button {
            onSetConversationPinned(entry.conversationID, !entry.isPinned)
        } label: {
            if entry.isPinned {
                Label("Odepnij", systemImage: "pin.slash")
            } else {
                Label("Przypnij na górze", systemImage: "pin")
            }
        }

        Divider()

        Button(role: .destructive) {
            conversationPendingDeletion = entry
        } label: {
            Label("Usuń rozmowę", systemImage: "trash")
        }
    }
}

private struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct PendingQuestionRow: View {
    let question: PendingQuestionListItem
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button {
            onTap()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(question.question_text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                if let createdAt = HistoryDateText.parse(question.created_at), let day = HistoryDateText.dayLabel(for: createdAt) {
                    Text(day)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.16) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(isSelected ? Color.accentColor.opacity(0.35) : Color.clear, lineWidth: 1)
            )
            .padding(.horizontal, 8)
        }
        .buttonStyle(.plain)
    }
}

private struct Badge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.accentColor)
            .clipShape(Capsule())
    }
}

struct ConversationHistoryRow<Actions: View>: View {
    let entry: ConversationHistoryItem
    let isSelected: Bool
    /// Only the pinned section mixes days; the others name the day, so the row label would repeat it. No hour: the list
    /// is about which conversation, not when.
    let showsDate: Bool
    let onTap: () -> Void
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            Button {
                onTap()
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if entry.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.orange)
                            .rotationEffect(.degrees(45))
                            .accessibilityHidden(true)
                    }
                    Text(entry.title)
                        .font(.subheadline.weight(isSelected ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Spacer(minLength: 4)

                    if showsDate, let day = HistoryDateText.dayLabel(for: entry.createdAt) {
                        Text(day)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 12)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(entry.isPinned ? "Przypięta, \(entry.title)" : entry.title)
            .accessibilityAddTraits(isSelected ? .isSelected : [])

            Menu {
                actions()
            } label: {
                Image(systemName: "ellipsis")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Opcje rozmowy \(entry.title)")
        }
        .padding(.trailing, 4)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.14) : Color.clear)
        )
        .padding(.horizontal, 8)
    }
}

private extension Color {
    static var shellChromeSurface: Color {
#if canImport(UIKit)
        Color(uiColor: .secondarySystemBackground)
#elseif canImport(AppKit)
        Color(nsColor: .controlBackgroundColor)
#else
        Color.gray.opacity(0.1)
#endif
    }
}

private extension ConversationHistorySectionKey {
    /// Pinned rows come from different days and need the day.
    var mixesDays: Bool {
        self == .pinned
    }
}

enum HistoryDateText {
    private static let polish = Locale(identifier: "pl_PL")

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = polish
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let date: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = polish
        formatter.setLocalizedDateFormatFromTemplate("d MMM")
        return formatter
    }()

    static func label(for value: Date, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(value) {
            return time.string(from: value)
        }
        if calendar.isDateInYesterday(value) {
            return "wczoraj"
        }
        return date.string(from: value)
    }

    /// The day without the hour: nil today, "wczoraj", or the date.
    static func dayLabel(for value: Date, calendar: Calendar = .current) -> String? {
        calendar.isDateInToday(value) ? nil : label(for: value, calendar: calendar)
    }

    static func parse(_ value: String) -> Date? {
        ServerDate.parse(value)
    }
}

/// The bolus card confirmation, only where remote commands are on.
private struct OptionalRemoteBolusConfirmation: ViewModifier {
    let flow: RemoteBolusFlow?

    func body(content: Content) -> some View {
        if let flow {
            content.remoteBolusConfirmation(flow: flow, showsFailureAlert: true)
        } else {
            content
        }
    }
}
