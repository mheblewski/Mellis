import SwiftUI
import Combine
import PhotosUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct ConversationView: View {
    @Environment(\.loopSystem) private var loopSystem
    /// The server's monthly AI limit is used up: said above the composer, where the answer would appear.
    @Environment(\.aiLimitNotice) private var aiLimitNotice
    @StateObject private var viewModel: ConversationViewModel
    @State private var keyboardHeight: CGFloat = 0
    /// The keyboard scrolls the timeline to the latest message only for the composer, not for the hypo form's fields.
    @State private var isComposerFocused = false
    @State private var libraryItems: [PhotosPickerItem] = []
    @State private var isLibraryPresented = false
    @State private var isCameraPresented = false
    /// The meal starter card opened the camera or the library: the first photo added puts its text in the composer.
    @State private var prefillsMealDraft = false
    /// The meal change card whose values are being corrected ("Popraw").
    @State private var editedMealAction: ConversationMealAction?
    /// The rescue carbs sheet ("Zatwierdź Y g" on a chat card).
    @State private var rescueCarbsSheet: RescueCarbsSheetRequest?
    /// Height of the timeline left visible above the composer and the keyboard.
    @State private var visibleTimelineHeight: CGFloat = 0
    /// The scroll that puts a sent message at the top, with its corrections (a newer send cancels it).
    @State private var pinTask: Task<Void, Never>?
    /// The conversation last scrolled to its latest message when it appeared.
    @State private var autoScrolledConversationID: String?
    @Environment(\.liveUpdates) private var liveUpdates
    /// Reveals of answers written on this screen, so a stored answer goes on from its draft.
    @StateObject private var revealStore = TextRevealStore()

    private let conversationID: String?
    private let refreshNonce: Int
    private let onStartNewConversation: (() -> Void)?
    private let isStartingNewConversation: Bool
    /// Opens a meal in the meals tab ("Otwórz posiłek" on a saved meal change card).
    private let onOpenMeal: ((String) -> Void)?
    /// Opens the confirmation for a bolus card; nil when this caregiver cannot send remote commands.
    private let onGiveBolus: ((RemoteBolusDraftBase) -> Void)?
    /// The caregiver's name for the greeting of an empty new conversation.
    private let greetingName: String?
    /// The tab is still choosing which conversation to open: nothing is shown until it has.
    private let isChoosingConversation: Bool
    private let bottomAnchorID = "timeline-bottom-anchor"
    /// The space between the timeline and the keyboard inset below it (SwiftUI's default for a safe area inset).
    private static let keyboardInsetSpacing: CGFloat = 8
    private let currentTurnID = "timeline-current-turn"
    /// The space above the first item: scrolling to it shows the timeline from its very top.
    private let topAnchorID = "timeline-top-anchor"

    public init(
        viewModel: ConversationViewModel,
        conversationID: String?,
        refreshNonce: Int = 0,
        onStartNewConversation: (() -> Void)? = nil,
        isStartingNewConversation: Bool = false,
        onOpenMeal: ((String) -> Void)? = nil,
        onGiveBolus: ((RemoteBolusDraftBase) -> Void)? = nil,
        greetingName: String? = nil,
        isChoosingConversation: Bool = false
    ) {
        _viewModel = StateObject(wrappedValue: viewModel)
        self.conversationID = conversationID
        self.refreshNonce = refreshNonce
        self.onStartNewConversation = onStartNewConversation
        self.isStartingNewConversation = isStartingNewConversation
        self.onOpenMeal = onOpenMeal
        self.onGiveBolus = onGiveBolus
        self.greetingName = greetingName
        self.isChoosingConversation = isChoosingConversation
    }

    public var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                // One loader for choosing the conversation and reading it, so it never starts over in between. A chosen
                // conversation not yet being read counts too: for a frame on the tab's first opening it used to flash
                // "no conversation" (its logo in the middle) before the new conversation came in.
                if viewModel.state == .loading || (viewModel.state == .idle && (isChoosingConversation || conversationID != nil)) {
                    DelayedLoadingIndicator()
                } else {
                    switch viewModel.state {
                    case .idle, .loading:
                        emptyState
                    case .error(let message):
                        loadErrorState(message)
                    case .loaded:
                        timelineView(proxy: proxy)
                    }
                }
            }
            // Floats over the timeline, which scrolls on under the glass.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if viewModel.state == .loaded {
                    composer
                }
            }
            .background(Color.conversationSurface)
            .animation(.easeInOut(duration: 0.2), value: keyboardHeight)
            .task(id: liveUpdates.map(ObjectIdentifier.init)) {
                viewModel.bindLiveUpdates(liveUpdates)
            }
            .task(id: onGiveBolus != nil) {
                viewModel.bolusCardsAvailable = onGiveBolus != nil
            }
            .task(id: conversationID) {
                await viewModel.selectConversation(conversationID)
            }
            // Read when the chat opens, so a new conversation's first card already knows the glucose.
            .task {
                await viewModel.refreshStarterGlucose()
            }
            .task(id: refreshNonce) {
                guard conversationID != nil else {
                    return
                }

                await viewModel.refreshActiveConversation()
            }
#if canImport(UIKit)
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
                guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
                    return
                }

                let keyboardVisibleHeight = max(0, UIScreen.main.bounds.height - frame.origin.y)
                keyboardHeight = keyboardVisibleHeight

                if keyboardVisibleHeight > 0, isComposerFocused {
                    scrollToBottom(proxy: proxy, animated: true)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                keyboardHeight = 0
            }
#endif
            // As in ChatGPT: a sent message moves to the top of the screen and the reply grows below it; the
            // timeline does not follow the reply down.
            .onChange(of: viewModel.localEchoMessage?.id) { _, echoID in
                if echoID != nil {
                    pinCurrentTurnToTop(proxy: proxy)
                }
            }
            .photosPicker(
                isPresented: $isLibraryPresented,
                selection: $libraryItems,
                maxSelectionCount: max(1, ConversationViewModel.maxPhotosPerMessage - viewModel.draftPhotos.count),
                matching: .images
            )
            .onChange(of: libraryItems) { _, items in
                Task { await loadLibraryItems(items) }
            }
            .onChange(of: viewModel.draftPhotos.count) { old, new in
                guard new > old, prefillsMealDraft else { return }
                prefillsMealDraft = false
                if viewModel.userMessageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    viewModel.userMessageText = ConversationStarters.mealPhotoDraft(bolusCards: viewModel.bolusCardsAvailable)
                }
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
            .sheet(item: $editedMealAction) { action in
                MealActionEditSheet(action: action) { edit in
                    await viewModel.applyMealAction(action, edited: edit)
                }
            }
            .sheet(item: $rescueCarbsSheet) { request in
                RescueCarbsLogSheet(
                    request: request,
                    isSaving: viewModel.isLoggingRescueCarbs,
                    errorMessage: viewModel.rescueCarbsError,
                    onSave: { grams, givenAt in
                        await viewModel.logRescueCarbs(carbsG: grams, givenAt: givenAt, proposalID: request.proposalID)
                    },
                    onCancel: { rescueCarbsSheet = nil },
                    onSendToTrio: onGiveBolus.map { give in
                        { grams in
                            give(.rescueCarbs(grams: grams, conversationID: viewModel.selectedConversationID ?? conversationID, alertID: viewModel.rescueCarbs?.alert_id, proposalID: request.proposalID))
                        }
                    }
                )
                .onAppear { viewModel.clearRescueCarbsError() }
            }
            .closesForNotification(isPresented: isLibraryPresented) { isLibraryPresented = false }
            .closesForNotification(isPresented: isCameraPresented) { isCameraPresented = false }
            .closesForNotification(isPresented: editedMealAction != nil) { editedMealAction = nil }
            .closesForNotification(isPresented: rescueCarbsSheet != nil) { rescueCarbsSheet = nil }
        }
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

    // MARK: - States

    /// No conversation open (the history could not be read, or the open one was deleted): the logo and "Mellis" as
    /// on a new conversation, with a button for one.
    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 0) {
            Image("LogoLarge", bundle: .main)
                .resizable()
                .scaledToFit()
                .frame(width: 76, height: 76)
                .accessibilityHidden(true)
            BrandWordmark.text()
                .font(.system(size: 32, weight: .bold))
                .padding(.top, 16)
                .accessibilityLabel("Mellis")
            Text("Zacznij nową rozmowę albo wybierz jedną z historii.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 6)
            if let onStartNewConversation {
                Button {
                    onStartNewConversation()
                } label: {
                    Label("Nowa rozmowa", systemImage: "square.and.pencil")
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .disabled(isStartingNewConversation)
                .padding(.top, 32)
            }
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadErrorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label(message, systemImage: "exclamationmark.bubble")
        } description: {
            Text("Wcześniej zapisane wiadomości nie zostały utracone.")
        } actions: {
            Button("Spróbuj ponownie") {
                Task {
                    await viewModel.retryAfterError()
                }
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Timeline

    @ViewBuilder
    private func timelineView(proxy: ScrollViewProxy) -> some View {
        let items = viewModel.timelineItems
        ScrollView {
            // Not lazy: a lazy stack places rows it has not measured from estimates, and with tall cards and photos
            // above them the estimates were far off. The scroll to a sent message then left it above the screen, and
            // the estimated content could even end before the new message (an empty screen, no way to scroll to it).
            VStack(alignment: .leading, spacing: 0) {
                Color.clear
                    .frame(height: 16)
                    .id(topAnchorID)

                if let hypo = viewModel.hypo {
                    // A hypo conversation from before (none are started now): what happened, then its chat.
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        HypoEpisodeHeader(hypo: hypo, stale: AlertStaleness.stale(hypo, now: context.date))
                    }
                    .frame(maxWidth: 680, alignment: .leading)
                    .padding(.bottom, 20)

                    if !items.contains(where: isUserTurnStart) {
                        HypoChatIntro(canSend: viewModel.canSendUserMessage) { question in
                            Task {
                                await viewModel.submitSuggestedFollowUp(question)
                            }
                        }
                        .padding(.bottom, items.isEmpty ? 0 : 20)
                    }
                } else if let rescue = viewModel.rescueCarbs {
                    // A rescue carbs alert's conversation: the forecast and the dose, then its chat. Over 30 min after its
                    // push it is history (stale-alerts.v1): a badge and its glucose "wtedy".
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        RescueCarbsSection(
                            rescue: rescue,
                            notice: viewModel.rescueCarbsNotice,
                            stale: AlertStaleness.stale(rescue, now: context.date)
                        )
                    }
                    .padding(.bottom, 20)
                } else if viewModel.wbt != nil {
                    // A meal's WBT conversation (wbt-chat.v1): what it can do, until its chat has started.
                    if !items.contains(where: isUserTurnStart) {
                        HypoChatIntro.wbt(canSend: viewModel.canSendUserMessage) { question in
                            Task {
                                await viewModel.submitSuggestedFollowUp(question)
                            }
                        }
                        .padding(.bottom, items.isEmpty ? 0 : 20)
                    }
                } else if items.isEmpty, visibleTimelineHeight > 0 {
                    // Only once the visible height is known: on the tab's first opening it is measured in the same
                    // update that starts the entrance, and the move from the top to the middle rode on its spring
                    // (the logo seemed to fly in from above).
                    newConversationStart
                }

                let turnStart = items.lastIndex(where: isUserTurnStart) ?? items.count
                ForEach(Array(items.enumerated().prefix(turnStart)), id: \.element.id) { index, _ in
                    timelineRow(items, at: index)
                }

                // The latest message and everything after it fill at least the visible height, so the message can
                // sit at the top of the screen however short the reply is.
                if turnStart < items.count {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(items.enumerated().dropFirst(turnStart)), id: \.element.id) { index, _ in
                            timelineRow(items, at: index)
                        }
                    }
                    // The top and bottom space and the 1 pt bottom anchor make up the rest of the visible height. The
                    // first turn fills exactly what is visible above the keyboard inset, so nothing scrolls it under
                    // the top bar (the composer shrinking after a send of several lines or photos used to).
                    .frame(minHeight: max(0, visibleTimelineHeight - (turnStartsTimeline ? 33 + timelineBottomInset : 17)), alignment: .top)
                    .id(currentTurnID)
                }

                Color.clear
                    .frame(height: 1)
                    .id(bottomAnchorID)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .modifier(InitialScrollAnchor(anchor: followsLatestMessage ? .bottom : .top))
        // A scroll view of its own for each conversation: a new one opened at once (no loading in between) never keeps
        // the previous conversation's scroll position, which iOS would only correct later (a jump on the next tab).
        .id(viewModel.selectedConversationID)
        .background(Color.conversationSurface)
        .safeAreaInset(edge: .bottom, spacing: Self.keyboardInsetSpacing) {
            Color.clear.frame(height: keyboardInsetHeight)
        }
        // The frame already excludes the top bar, the composer and the keyboard.
        .onGeometryChange(for: CGFloat.self) { geometry in
            geometry.size.height
        } action: { height in
            visibleTimelineHeight = height
        }
        .onAppear {
            // Only when a conversation opens: coming back from another tab keeps what was on screen (it used to jump to
            // the latest message, away from what the caregiver was reading).
            guard viewModel.selectedConversationID != autoScrolledConversationID else { return }
            autoScrolledConversationID = viewModel.selectedConversationID
            if followsLatestMessage {
                scrollToBottom(proxy: proxy, animated: false)
            }
        }
    }

    private func timelineRow(_ items: [ConversationViewModel.TimelineItem], at index: Int) -> some View {
        let item = items[index]
        let startsGroup = index == 0 || TimelineSide(items[index - 1]) != TimelineSide(item)
        // The caregiver message an answer replies to: the one before it (keys the reveal of a streamed answer).
        let answeredUserMessageID = items[..<index].reversed().lazy.compactMap { previous -> String? in
            if case .userMessage(let message) = previous { return message.id }
            return nil
        }.first
        return timelineItemView(item, startsGroup: startsGroup, isLast: index == items.count - 1, answeredUserMessageID: answeredUserMessageID)
            // Below a hypo's form the first message keeps the usual gap, so it sits as low under the top bar as in
            // other conversations once it moves to the top.
            .padding(.top, index == 0 ? (hasTopBlock ? 18 : 0) : (startsGroup ? 18 : 6))
            .id(item.id)
    }

    /// A message the user sent, or is sending, starts a turn.
    private func isUserTurnStart(_ item: ConversationViewModel.TimelineItem) -> Bool {
        switch item {
        case .userMessage, .localEcho:
            return true
        default:
            return false
        }
    }

    /// The hypo screen or the rescue carbs alert block sits above the messages.
    private var hasTopBlock: Bool {
        viewModel.hypo != nil || viewModel.rescueCarbs != nil || viewModel.wbt != nil
    }

    /// A hypo screen (or a rescue carbs alert) stays at its summary and form until its chat has started; other
    /// conversations follow the latest message.
    private var followsLatestMessage: Bool {
        guard hasTopBlock else {
            return true
        }
        return viewModel.timelineItems.contains(where: isUserTurnStart)
    }

    /// The logo, "Mellis" and three starter cards, centred in the visible height (the top and bottom space and the
    /// 1 pt bottom anchor take the rest).
    private var newConversationStart: some View {
        NewConversationStartView(
            greetingName: greetingName,
            glucose: viewModel.starterGlucose,
            glucoseSettled: viewModel.starterGlucoseSettled,
            bolusCards: viewModel.bolusCardsAvailable,
            canSend: viewModel.canSendUserMessage,
            canAddPhoto: viewModel.canAddPhoto,
            onSend: { question in
                Task {
                    await viewModel.submitSuggestedFollowUp(question)
                }
            },
            onMealPhoto: { source in
                prefillsMealDraft = true
                switch source {
                case .camera: isCameraPresented = true
                case .library: isLibraryPresented = true
                }
            }
        )
        .frame(maxWidth: .infinity)
        // Exactly the visible height (also without the keyboard inset), so nothing scrolls: with any overflow the
        // screen would sit higher or lower depending on the scroll position (a jump after changing tabs).
        .frame(minHeight: max(0, visibleTimelineHeight - 33 - timelineBottomInset))
        .task {
            await viewModel.refreshStarterGlucose()
        }
    }

    /// The cards an answer prepared (meal changes, bolus cards), right under its text (nil when it prepared none).
    private func answerCards(_ message: ConversationMessage) -> AnyView? {
        let options = AnswerOptionsPresentation(message: message, chosenKey: viewModel.answerOptionChoices[message.id], treatedProposalID: viewModel.rescueCarbs?.treatment?.proposal_id)
        let meals = mealActionCards(message.meal_actions)
        // Cards of an option live in its card of the list. Under options every card belongs to one: a card without one
        // (an answer stored before the server dropped them) shows only if something was already sent from it.
        let boluses = bolusCards(message.bolus_proposals?.filter { card in options.map { !$0.owns(optionKey: card.option_key) && card.state == "SENT" } ?? true })
        let rescues = rescueCarbCards(message.rescue_carb_proposals?.filter { card in options.map { !$0.owns(optionKey: card.option_key) && (card.isAccepted || card.logged != nil) } ?? true })
        let reminders = careReminderCards(message.care_reminders)
        let wbt = wbtCard(message.wbt_proposal)
        if options == nil && meals == nil && boluses == nil && rescues == nil && reminders == nil && wbt == nil { return nil }
        return AnyView(VStack(alignment: .leading, spacing: 10) {
            if let meals { meals }
            if let options {
                AnswerOptionList(
                    presentation: options,
                    message: message,
                    onSelect: { key in
                        withAnimation(.easeInOut(duration: 0.28)) {
                            viewModel.chooseAnswerOption(messageID: message.id, key: key)
                        }
                        if key == AnswerOptionsPresentation.ownPlanKey {
                            isComposerFocused = true
                        }
                    }
                ) { key in
                    let rescues = message.rescue_carb_proposals?.filter { $0.option_key == key } ?? []
                    // One plan, one line: the rescue carbs open the first bolus card's timeline, their button above its own.
                    if let bolus = bolusCards(message.bolus_proposals?.filter { $0.option_key == key }, embedded: true, leadingRescues: rescues) {
                        bolus
                    } else if let rescue = rescueCarbCards(rescues, embedded: true) {
                        rescue
                    }
                }
                .padding(.top, 4)
            }
            if let boluses { boluses }
            if let rescues { rescues }
            if let reminders { reminders }
            if let wbt { wbt }
        })
    }

    /// The WBT dose an answer of a meal's WBT conversation proposed (wbt-chat.v1): the newest one is given like the WBT
    /// screen's dose; an older one was replaced.
    private func wbtCard(_ proposal: ConversationWbtProposal?) -> AnyView? {
        guard let proposal else { return nil }
        guard proposal.newest, let card = MealWbtView.chatCard(proposal) else {
            return AnyView(
                Label("Wcześniejsza propozycja: \(LoopFormat.units(proposal.dose_units)) — zastąpiona nowszą.", systemImage: "arrow.uturn.down")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            )
        }
        return AnyView(
            BolusProposalCard(
                proposal: card,
                onGive: card.state == "PROPOSED" ? onGiveBolus.flatMap { give in MealWbtView.chatBase(proposal).map { base in { give(base) } } } : nil,
                onRetry: onGiveBolus.flatMap { give in MealWbtView.wbtRetryBase(proposal.command, mealID: proposal.meal_id).map { base in { give(base) } } },
                onRecalculate: nil,
                onOpenMeal: onOpenMeal
            )
            .padding(.top, 4)
        )
    }

    /// Reminders the answer set (care-reminders.v1), with "Anuluj" while they are active.
    private func careReminderCards(_ reminders: [ConversationCareReminder]?) -> AnyView? {
        guard let reminders, !reminders.isEmpty else { return nil }
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                ForEach(reminders) { reminder in
                    CareReminderCard(
                        reminder: reminder,
                        onCancel: viewModel.careRemindersInFlight.contains(reminder.id) ? nil : {
                            Task { @MainActor in await viewModel.cancelCareReminder(reminder) }
                        },
                        error: viewModel.careReminderErrors[reminder.id]
                    )
                }
            }
            .padding(.top, 4)
        )
    }

    /// Rescue doses the answer proposed (in an alert's conversation or an ordinary one); "Zatwierdź Y g" opens the rescue
    /// carbs sheet.
    /// "Podano 7 g" for a rescue card (opens the rescue carbs sheet); nil once logged, replaced or while a save runs.
    /// A card proposed over 30 min ago (stale-alerts.v1) opens the sheet to log only: nothing goes to the loop from it.
    private func confirmRescue(_ proposal: ConversationRescueCarbProposal) -> (() -> Void)? {
        guard !viewModel.isLoggingRescueCarbs else { return nil }
        let loop = loopSystem.names
        return {
            rescueCarbsSheet = RescueCarbsSheetRequest(
                grams: proposal.carbs_g,
                proposalID: proposal.id,
                hint: "Propozycja z rozmowy: \(RescueCarbsFormat.grams(proposal.carbs_g)) g",
                sendBlockedReason: AlertStaleness.stale(proposal, now: Date())?.cardReason(loop: loop)
            )
        }
    }

    /// The rescue carbs' button on an option's bolus card; nil once they were logged.
    private func rescueButton(_ proposals: [ConversationRescueCarbProposal]) -> AnyView? {
        let treatment = viewModel.rescueCarbs?.treatment
        let open = proposals.filter { RescueCarbProposalCard.decidedLine(proposal: $0, treatment: treatment) == nil && !$0.isSuperseded }
        guard !open.isEmpty else { return nil }
        return AnyView(TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 8) {
                ForEach(open) { proposal in
                    if let staleReason = AlertStaleness.stale(proposal, now: context.date)?.cardReason(loop: loopSystem.names) {
                        StaleAlertReason(text: staleReason)
                    }
                    Button { confirmRescue(proposal)?() } label: {
                        Label("Podano \(RescueCarbsFormat.grams(proposal.carbs_g)) g", systemImage: "checkmark")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.rescue)
                    .controlSize(.large)
                    .disabled(confirmRescue(proposal) == nil)
                }
            }
        })
    }

    private func rescueCarbCards(_ proposals: [ConversationRescueCarbProposal]?, embedded: Bool = false) -> AnyView? {
        guard let proposals, !proposals.isEmpty else { return nil }
        let rescue = viewModel.rescueCarbs
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                ForEach(proposals) { proposal in
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        RescueCarbProposalCard(
                            proposal: proposal,
                            treatment: rescue?.treatment,
                            inAlert: rescue != nil,
                            // Not while a save is running.
                            onConfirm: confirmRescue(proposal),
                            embedded: embedded,
                            // Proposed over 30 min ago (stale-alerts.v1): of a glucose that has changed since; logs only.
                            staleReason: AlertStaleness.stale(proposal, now: context.date)?.cardReason(loop: loopSystem.names)
                        )
                    }
                }
            }
            .padding(.top, embedded ? 0 : 4)
        )
    }

    private func bolusCards(_ proposals: [ConversationBolusProposal]?, embedded: Bool = false, leadingRescues: [ConversationRescueCarbProposal] = []) -> AnyView? {
        // No bolus card where no bolus can be given (remote commands off, or this phone not set up for the patient),
        // except inside an option: there it shows the plan read-only, or the unfolded option would be empty.
        guard let proposals, !proposals.isEmpty, onGiveBolus != nil || embedded else { return nil }
        let conversationID = viewModel.selectedConversationID ?? conversationID
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                ForEach(proposals) { proposal in
                    BolusProposalCard(
                        proposal: proposal,
                        onGive: proposal.canGiveDraft ? onGiveBolus.flatMap { give in conversationID.map { id in { give(proposal.draftBase(conversationID: id)) } } } : nil,
                        onRetry: onGiveBolus.flatMap { give in conversationID.flatMap { id in proposal.retryBase(conversationID: id).map { base in { give(base) } } } },
                        onRecalculate: viewModel.canSendUserMessage ? recalculateBolus : nil,
                        onOpenMeal: onOpenMeal,
                        onSkipPart: { part in Task { @MainActor in await viewModel.skipPlannedPart(part) } },
                        onSetWbtReminder: { mealID, enabled in Task { @MainActor in await viewModel.setCardWbtReminder(mealID: mealID, enabled: enabled) } },
                        busySwitches: viewModel.cardSwitchesInFlight,
                        embedded: embedded,
                        leadingSteps: proposal.id == proposals.first?.id ? leadingRescues.map { RescueCarbProposalCard.timelineStep(proposal: $0, treatment: viewModel.rescueCarbs?.treatment, loop: loopSystem.names) } : [],
                        leadingAction: proposal.id == proposals.first?.id ? rescueButton(leadingRescues) : nil
                    )
                }
            }
            .padding(.top, embedded ? 0 : 4)
        )
    }

    /// An expired bolus card: the chat computes the dose again on current data.
    private func recalculateBolus() {
        Task { @MainActor in
            await viewModel.submitSuggestedFollowUp("Przelicz tę dawkę na aktualnych danych")
        }
    }

    /// The meal change cards an answer prepared, right under its text (nil when it prepared none).
    private func mealActionCards(_ actions: [ConversationMealAction]?) -> AnyView? {
        guard let actions, !actions.isEmpty else { return nil }
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                ForEach(actions) { action in
                    MealActionCard(
                        action: action,
                        isBusy: viewModel.mealActionsInFlight.contains(action.id),
                        errorMessage: viewModel.mealActionErrors[action.id],
                        onApply: { Task { await viewModel.applyMealAction(action) } },
                        onEdit: { editedMealAction = action },
                        onReject: { Task { await viewModel.rejectMealAction(action) } },
                        onUndo: { Task { await viewModel.undoMealAction(action) } },
                        onOpenMeal: onOpenMeal
                    )
                }
            }
            .padding(.top, 4)
        )
    }

    @ViewBuilder
    private func timelineItemView(_ item: ConversationViewModel.TimelineItem, startsGroup: Bool, isLast: Bool, answeredUserMessageID: String? = nil) -> some View {
        switch item {
        case .assistantDraft(let draft):
            // Laid out exactly like the stored answer that replaces it, so nothing moves when it arrives.
            StreamingAssistantMessageView(text: draft.content, showsAuthor: startsGroup, revealer: revealStore.revealer(for: draft.reply_to_message_id))
        case .assistantMessage(let message) where revealStore.existing(for: answeredUserMessageID) != nil:
            RevealingAssistantMessageView(
                text: message.content,
                showsAuthor: startsGroup,
                revealer: revealStore.existing(for: answeredUserMessageID)!,
                aiCostText: AIResponseCostPresentation.labelText(for: message.ai_cost),
                sources: message.knowledge_sources ?? [],
                suggestions: isLast && viewModel.canSendUserMessage && (message.answer_options ?? []).isEmpty ? (message.suggested_follow_ups ?? []) : [],
                hotSuggestion: message.hot_suggested_follow_up,
                onSuggestion: { suggestion in
                    Task {
                        await viewModel.submitSuggestedFollowUp(suggestion)
                    }
                },
                attachment: answerCards(message)
            )
        case .assistantMessage(let message):
            AssistantMessageView(
                text: message.content,
                showsAuthor: startsGroup,
                aiCostText: AIResponseCostPresentation.labelText(for: message.ai_cost),
                sources: message.knowledge_sources ?? [],
                // Only under the latest answer, and only while a new message can be sent.
                suggestions: isLast && viewModel.canSendUserMessage && (message.answer_options ?? []).isEmpty ? (message.suggested_follow_ups ?? []) : [],
                hotSuggestion: message.hot_suggested_follow_up,
                onSuggestion: { suggestion in
                    Task {
                        await viewModel.submitSuggestedFollowUp(suggestion)
                    }
                },
                attachment: answerCards(message)
            )
        case .userMessage(let message):
            // While the cancellation confirmation is shown in the status, the note would only repeat it.
            VStack(alignment: .trailing, spacing: 6) {
                if let photoIDs = message.photo_ids, !photoIDs.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(photoIDs, id: \.self) { photoID in
                            ConversationRemotePhoto(photoID: photoID, viewModel: viewModel)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if !message.displayContent.isEmpty || message.photo_ids?.isEmpty != false {
                    UserMessageBubble(
                        text: message.displayContent,
                        author: message.author_display_name,
                        note: message.isAnalysisCancelled && !viewModel.isShowingCancellationConfirmation ? "Analiza przerwana" : nil
                    )
                }
            }
        case .localEcho(let localEcho):
            VStack(alignment: .trailing, spacing: 6) {
                if !localEcho.photos.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(localEcho.photos.enumerated()), id: \.offset) { _, data in
                            MealPhotoThumbnail(data: data, size: 110)
                                .opacity(0.6)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if !localEcho.content.isEmpty {
                    UserMessageBubble(text: localEcho.content, isPending: true, reservesAuthorLine: true)
                }
            }
        case .question(let question):
            QuestionView(
                question: question,
                textAnswer: $viewModel.textAnswer,
                isSubmitting: viewModel.isSubmittingAnswer || viewModel.isSubmittingUserMessage,
                onSelect: { answerType in
                    Task {
                        await viewModel.submitAnswer(answerType)
                    }
                },
                onSelectOption: { option in
                    Task {
                        await viewModel.submitAnswerOption(option)
                    }
                }
            )
        case .processing:
            if let activity = viewModel.agentActivity {
                AgentStatusView(
                    activity: activity,
                    notice: viewModel.cancellationNotice,
                    retryTitle: viewModel.canRetryFailedSubmission
                        ? "Spróbuj ponownie"
                        : viewModel.canRetryFailedAnalysis ? "Ponów próbę" : "Odśwież rozmowę",
                    onRetry: {
                        Task {
                            if viewModel.canRetryFailedSubmission {
                                await viewModel.retryFailedSubmission()
                            } else if viewModel.canRetryFailedAnalysis {
                                await viewModel.retryFailedAnalysis()
                            } else {
                                await viewModel.retryAfterError()
                            }
                        }
                    }
                )
            }
        case .recommendation(let recommendation):
            RecommendationView(recommendation: recommendation)
        }
    }

    // MARK: - Composer

    private var isAwaitingAnswer: Bool {
        viewModel.conversation?.awaiting_user_answer == true
    }

    private var canSubmitComposer: Bool {
        viewModel.canSendUserMessage && viewModel.hasComposerContent
    }

    /// While the server reports the running analysis as cancellable, the send button (unusable then anyway)
    /// becomes a stop button, as in ChatGPT.
    private var showsStopButton: Bool {
        viewModel.canCancelAnalysis || viewModel.isCancellingAnalysis
    }

    private var stopButton: some View {
        Button {
            Task {
                await viewModel.cancelAnalysis()
            }
        } label: {
            Group {
                if viewModel.isCancellingAnalysis {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.white)
                }
            }
            .frame(width: 38, height: 38)
            .background(Circle().fill(viewModel.isCancellingAnalysis ? Color.secondary.opacity(0.18) : Color.accentColor))
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isCancellingAnalysis)
        .accessibilityLabel(viewModel.isCancellingAnalysis ? "Przerywam analizę" : "Przerwij analizę")
        .accessibilityHint("Zatrzymuje analizę tej wiadomości. Historia rozmowy zostanie zachowana.")
    }

    /// One glass bubble, as in ChatGPT: "+", the text and the send button inside it.
    @ViewBuilder
    private var composer: some View {
        VStack(spacing: 0) {
            if let aiLimitNotice {
                Label(aiLimitNotice, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .accessibilityIdentifier("conversation.aiLimitNotice")
            }
            if isAwaitingAnswer {
                Label("Odpowiedz na pytanie powyżej, aby kontynuować.", systemImage: "arrow.up")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            } else {
                ChatComposerBar(
                    placeholder: viewModel.hypo != nil ? "Zapytaj o to hipo" : viewModel.wbt != nil ? "Zapytaj o dawkę WBT" : "Napisz wiadomość",
                    text: $viewModel.userMessageText,
                    isFocused: $isComposerFocused,
                    photos: viewModel.draftPhotos,
                    canAddPhoto: viewModel.canAddPhoto,
                    photosLocked: viewModel.isSubmittingUserMessage,
                    onRemovePhoto: { viewModel.removeDraftPhoto(at: $0) },
                    onCamera: {
                        prefillsMealDraft = false
                        isCameraPresented = true
                    },
                    onLibrary: {
                        prefillsMealDraft = false
                        isLibraryPresented = true
                    },
                    // A photo pasted from the clipboard goes with the message, as one added with "+".
                    onPastePhotos: viewModel.canAddPhoto ? { photos in photos.forEach(viewModel.addPhoto) } : nil,
                    voiceInput: viewModel.voiceTranscribe
                ) {
                    if showsStopButton {
                        stopButton
                    } else {
                        ChatSendButton(isEnabled: canSubmitComposer) {
                            Task {
                                await viewModel.submitUserMessage()
                            }
                        }
                    }
                }
            }
        }
        .chatComposerChrome()

    }

    /// True when nothing is above the latest turn: the first message of an ordinary conversation.
    private var turnStartsTimeline: Bool {
        !hasTopBlock && viewModel.timelineItems.lastIndex(where: isUserTurnStart) == 0
    }

    /// The extra space between the timeline and the keyboard.
    private var keyboardInsetHeight: CGFloat {
        keyboardHeight > 0 ? keyboardHeight * 0.15 : 0
    }

    /// The part of the timeline's frame taken by its bottom inset (its spacing and the space over the keyboard).
    private var timelineBottomInset: CGFloat {
        Self.keyboardInsetSpacing + keyboardInsetHeight
    }

    private func pinCurrentTurnToTop(proxy: ScrollViewProxy) {
        // The first message of a conversation keeps its place under the top bar: the timeline's top, not the turn's
        // top (which would put the message's author line against the bar).
        let target = turnStartsTimeline ? topAnchorID : currentTurnID
        pinTask?.cancel()
        pinTask = Task { @MainActor in
            await Task.yield()

            withAnimation(.easeOut(duration: 0.3)) {
                proxy.scrollTo(target, anchor: .top)
            }
            await ScrollPinCorrection.settle { proxy.scrollTo(target, anchor: .top) }
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool) {
        Task { @MainActor in
            await Task.yield()

            if animated {
                withAnimation(.easeOut(duration: 0.22)) {
                    proxy.scrollTo(bottomAnchorID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            }
        }
    }
}

/// Which side of the conversation an item belongs to; consecutive items of one side are grouped.
private enum TimelineSide: Equatable {
    case assistant
    case question
    case user
    case status

    init(_ item: ConversationViewModel.TimelineItem) {
        switch item {
        case .userMessage, .localEcho:
            self = .user
        case .processing:
            self = .status
        case .question:
            self = .question
        case .assistantMessage, .recommendation, .assistantDraft:
            self = .assistant
        }
    }
}

private extension Color {
    static var conversationSurface: Color {
#if canImport(UIKit)
    Color(uiColor: .systemBackground)
#elseif canImport(AppKit)
    Color(nsColor: .windowBackgroundColor)
#else
    Color.white
#endif
    }

    static var subtleFill: Color { Color.secondary.opacity(0.08) }
}

// MARK: - Messages

/// The answer while the model writes it, revealed smoothly (TextRevealer), in the layout of the stored answer.
struct StreamingAssistantMessageView: View {
    let text: String
    let showsAuthor: Bool
    @ObservedObject var revealer: TextRevealer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        AssistantMessageView(
            text: reduceMotion ? text : revealer.displayed,
            showsAuthor: showsAuthor,
            tailOpacities: reduceMotion ? [] : revealer.tailOpacities,
            isStreaming: true
        )
        .onAppear { revealer.setTarget(text) }
        .onChange(of: text) { _, newText in revealer.setTarget(newText) }
    }
}

/// The stored answer that replaced a draft on this screen: the text goes on from where the draft got to, and the
/// sources, cost and suggestions appear once it is all shown.
struct RevealingAssistantMessageView: View {
    let text: String
    let showsAuthor: Bool
    @ObservedObject var revealer: TextRevealer
    var aiCostText: String? = nil
    var sources: [KnowledgeSource] = []
    var suggestions: [String] = []
    var hotSuggestion: String? = nil
    var onSuggestion: (String) -> Void = { _ in }
    var attachment: AnyView? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if revealer.isFinished || reduceMotion {
                AssistantMessageView(text: text, showsAuthor: showsAuthor, aiCostText: aiCostText, sources: sources, suggestions: suggestions, hotSuggestion: hotSuggestion, onSuggestion: onSuggestion, animatesExtras: true, attachment: attachment)
            } else {
                AssistantMessageView(text: revealer.displayed, showsAuthor: showsAuthor, tailOpacities: revealer.tailOpacities, isStreaming: true)
            }
        }
        .onAppear { revealer.complete(with: text) }
        .onChange(of: text) { _, newText in revealer.complete(with: newText) }
    }
}

/// Final assistant answers are plain, full-width text (no bubble) so long and structured answers stay readable.
struct AssistantMessageView: View {
    let text: String
    let showsAuthor: Bool
    /// While the answer is written: the newest characters fade in, and cut markup is not shown raw.
    var tailOpacities: [Double] = []
    var isStreaming = false
    var aiCostText: String? = nil
    var sources: [KnowledgeSource] = []
    var suggestions: [String] = []
    var hotSuggestion: String? = nil
    var onSuggestion: (String) -> Void = { _ in }
    /// The answer was written on this screen: its sources, cost and suggestions come in one after another instead of
    /// all appearing at once.
    var animatesExtras = false
    /// Shown right under the text (the meal change cards the answer prepared).
    var attachment: AnyView? = nil

    /// The hot suggestion always on top (the server already stores it first; older answers may not).
    private var orderedSuggestions: [String] {
        guard let hotSuggestion, suggestions.contains(hotSuggestion) else {
            return suggestions
        }
        return [hotSuggestion] + suggestions.filter { $0 != hotSuggestion }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsAuthor {
                AuthorLabel()
            }

            MessageContentView(text: text, tailOpacities: tailOpacities, isStreaming: isStreaming)

            if let attachment {
                attachment
                    .entrance(step: 0, animated: animatesExtras)
            }

            if !sources.isEmpty {
                KnowledgeSourcesView(sources: sources)
                    .entrance(step: 0, animated: animatesExtras)
            }

            if let aiCostText {
                Text(aiCostText)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .entrance(step: 0, animated: animatesExtras)
            }

            if !suggestions.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(orderedSuggestions.enumerated()), id: \.element) { index, suggestion in
                        SuggestionChip(text: suggestion, isHot: suggestion == hotSuggestion) {
                            onSuggestion(suggestion)
                        }
                        .entrance(step: index + 1, animated: animatesExtras)
                    }
                }
                .padding(.top, 6)
            }
        }
        .frame(maxWidth: 680, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Fades an element in while it rises a few points, `step` × 90 ms after it appears, so a group comes in one by one.
/// Off (shown at once) when not animated or with Reduce Motion.
private struct EntranceModifier: ViewModifier {
    let step: Int
    let animated: Bool
    @State private var isShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let shown = isShown || !animated || reduceMotion
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 8)
            .animation(.spring(duration: 0.5, bounce: 0.2).delay(0.08 + Double(step) * 0.09), value: isShown)
            .onAppear { isShown = true }
    }
}

private extension View {
    func entrance(step: Int, animated: Bool) -> some View {
        modifier(EntranceModifier(step: step, animated: animated))
    }
}

/// A tappable next question. The one the model marked as most worth tapping has a border in the logo's colours that
/// slowly turns around it (still when Reduce Motion is on).
private struct SuggestionChip: View {
    let text: String
    let isHot: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "arrow.turn.down.right")
                    .font(.footnote)
                Text(text)
                    .font(.subheadline)
                    .fontWeight(isHot ? .semibold : .regular)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background {
                if isHot {
                    BrandGradientBorder(cornerRadius: 16)
                } else {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.accentColor.opacity(0.45), lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
        .accessibilityHint(isHot ? "Polecane pytanie. Wysyła to pytanie" : "Wysyła to pytanie")
    }
}

/// The logo's colours, mint to petrol and back, so the rotating gradient has no seam.
enum BrandColors {
    static let mint = Brand.rgb(0x5EEAD4)
    static let sky = Brand.teal
    static let interactive = Brand.interactive
    static let petrol = Brand.dynamic(light: 0x0E5A61, dark: 0x14B8A6)
    static let loop: [Color] = [mint, sky, interactive, petrol, interactive, sky, mint]
}

/// A rounded border in the logo's colours turning once every 6 s, with a soft glow and a faint tint inside.
struct BrandGradientBorder: View {
    let cornerRadius: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let secondsPerTurn: Double = 6

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: Self.secondsPerTurn) / Self.secondsPerTurn
            let gradient = AngularGradient(
                colors: BrandColors.loop,
                center: .center,
                angle: .degrees(reduceMotion ? 0 : turn * 360)
            )
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            shape
                .fill(BrandColors.sky.opacity(0.08))
                .overlay {
                    shape
                        .strokeBorder(gradient, lineWidth: 1.5)
                        .shadow(color: BrandColors.sky.opacity(0.45), radius: 5)
                }
        }
    }
}

/// The sources an answer cites ([S1], [S2] in its text), collapsed to one line until tapped.
private struct KnowledgeSourcesView: View {
    let sources: [KnowledgeSource]
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(sources, id: \.ref) { source in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("[\(source.ref)]")
                            .font(.caption2.monospacedDigit().weight(.semibold))
                        if let link = source.originalURL {
                            // Summaries and documentation pages: the title opens the original.
                            Link(destination: link) {
                                Text(source.displayDetail)
                                    .font(.caption2)
                                    .underline()
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .accessibilityHint("Otwiera oryginał")
                        } else {
                            Text(source.displayDetail)
                                .font(.caption2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 4)
        } label: {
            Label(sources.count == 1 ? "Źródło (1)" : "Źródła (\(sources.count))", systemImage: "book.closed")
                .font(.caption)
        }
        .foregroundStyle(.secondary)
        .tint(.secondary)
    }
}

/// Where a conversation opens: at its latest message from the first frame (the scroll to the bottom on appear came a
/// frame later, a visible jump), or at the top of a hypo screen. Only the first position: later growth (an answer being
/// written) is never followed. Before iOS 18 the scroll on appear alone does it.
private struct InitialScrollAnchor: ViewModifier {
    let anchor: UnitPoint

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.defaultScrollAnchor(anchor, for: .initialOffset)
        } else {
            content
        }
    }
}

/// "Wczytuję rozmowę…" only when choosing or reading the conversation takes a moment: a quick one shows nothing.
private struct DelayedLoadingIndicator: View {
    @State private var isVisible = false

    var body: some View {
        ProgressView("Wczytuję rozmowę…")
            .opacity(isVisible ? 1 : 0)
            .animation(.easeIn(duration: 0.2), value: isVisible)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .task {
                try? await Task.sleep(for: .milliseconds(300))
                isVisible = true
            }
    }
}

struct AuthorLabel: View {
    var body: some View {
        // The small hummingbird before the name, so the assistant's answers carry the brand.
        HStack(spacing: 5) {
            Image("Logo", bundle: .main)
                .resizable()
                .scaledToFit()
                .frame(width: 15, height: 15)
            Text("Mellis")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .accessibilityHidden(true)
    }
}

/// A photo of a caregiver message, downloaded once per conversation view.
private struct ConversationRemotePhoto: View {
    let photoID: String
    @ObservedObject var viewModel: ConversationViewModel
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

struct UserMessageBubble: View {
    let text: String
    /// Who wrote the message; both caregivers share the conversation. Nil for older messages and local echoes.
    var author: String? = nil
    var isPending = false
    /// A local echo keeps the author line's height empty, so the stored message that replaces it, with its author,
    /// does not shift the timeline.
    var reservesAuthorLine = false
    var note: String? = nil

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if let author = trimmedAuthor {
                Text(author)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            } else if reservesAuthorLine {
                Text(" ")
                    .font(.caption.weight(.semibold))
                    .accessibilityHidden(true)
            }
            bubble
            if let note {
                Label(note, systemImage: "stop.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var bubble: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .font(.body)
                .foregroundStyle(.white)
                .textSelection(.enabled)
                .padding(.vertical, 9)
                .padding(.horizontal, 14)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.accentColor.opacity(isPending ? 0.6 : 1))
                )
                .frame(maxWidth: 520, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isPending ? "\(speaker), wysyłanie: \(text)" : "\(speaker): \(text)")
    }

    private var trimmedAuthor: String? {
        let value = author?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    private var speaker: String {
        trimmedAuthor ?? "Ty"
    }
}

/// Renders message text with inline Markdown (line breaks and list markers preserved) and fenced code blocks.
struct MessageContentView: View {
    let text: String
    var tailOpacities: [Double] = []
    var isStreaming = false

    var body: some View {
        let segments = MessageContentSegment.parse(isStreaming ? StreamingMarkdown.displayable(text) : text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                let fades = index == segments.count - 1 ? tailOpacities : []
                switch segment {
                case .text(let value):
                    Text(StreamingMarkdown.fadeTail(Self.inlineMarkdown(value), opacities: fades))
                        .font(.body)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                case .code(let value):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(StreamingMarkdown.fadeTail(AttributedString(value), opacities: fades))
                            .font(.system(.callout, design: .monospaced))
                            .padding(10)
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.subtleFill)
                    )
                }
            }
        }
        .textSelection(.enabled)
    }

    private static func inlineMarkdown(_ value: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        let prepared = MessageContentSegment.preventUnitBreaks(MessageContentSegment.displayBlockMarkup(value))
        return (try? AttributedString(markdown: prepared, options: options)) ?? AttributedString(value)
    }
}

enum MessageContentSegment: Equatable {
    case text(String)
    case code(String)

    /// Inline-only Markdown keeps line breaks but not block syntax: show list markers as bullets and
    /// headings as bold lines instead of raw "-" and "#".
    static func displayBlockMarkup(_ text: String) -> String {
        text.components(separatedBy: "\n").map { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let indent = String(line.prefix(while: { $0 == " " }))
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                return indent + "• " + trimmed.dropFirst(2)
            }
            if let hashes = trimmed.firstIndex(where: { $0 != "#" }), hashes != trimmed.startIndex,
               trimmed[hashes] == " ", trimmed.distance(from: trimmed.startIndex, to: hashes) <= 6 {
                return "**" + trimmed[hashes...].trimmingCharacters(in: .whitespaces) + "**"
            }
            return line
        }.joined(separator: "\n")
    }

    /// Keeps a value with its unit and the unit itself on one line ("180 mg/dl" never breaks after "mg/").
    static func preventUnitBreaks(_ text: String) -> String {
        let wordJoiner = "\u{2060}"
        let noBreakSpace = "\u{00A0}"
        var result = text
        for unit in ["mg/dl", "mg/dL", "mmol/l", "mmol/L"] {
            let joined = unit.replacingOccurrences(of: "/", with: "/" + wordJoiner)
            result = result.replacingOccurrences(of: unit, with: joined)
        }
        // Number followed by a space and a unit: keep them together.
        return result.replacingOccurrences(
            of: #"(\d) (mg/|mmol/|g\b|j\.|%)"#,
            with: "$1" + noBreakSpace + "$2",
            options: .regularExpression
        )
    }

    /// Splits on ``` fences; an unterminated fence is treated as code to the end. Empty text segments are dropped.
    static func parse(_ text: String) -> [MessageContentSegment] {
        var segments: [MessageContentSegment] = []
        let parts = text.components(separatedBy: "```")
        for (index, part) in parts.enumerated() {
            if index % 2 == 1 {
                // Drop an optional language tag on the opening fence line.
                var lines = part.components(separatedBy: "\n")
                if let first = lines.first, !first.contains(" "), lines.count > 1 {
                    lines.removeFirst()
                }
                let code = lines.joined(separator: "\n").trimmingCharacters(in: .newlines)
                if !code.isEmpty {
                    segments.append(.code(code))
                }
            } else {
                let value = part.trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty {
                    segments.append(.text(value))
                }
            }
        }
        return segments
    }
}

// MARK: - Question

private struct QuestionView: View {
    let question: PendingQuestion
    @Binding var textAnswer: String
    let isSubmitting: Bool
    let onSelect: (AnswerType) -> Void
    let onSelectOption: (QuestionAnswerOption) -> Void

    /// Tak / Nie / Nie wiem when the server sent no options of its own (older servers).
    private static let defaultOptions = [
        QuestionAnswerOption(label: "Tak", answer_type: .yes),
        QuestionAnswerOption(label: "Nie", answer_type: .no),
        QuestionAnswerOption(label: "Nie wiem", answer_type: .unknown),
    ]

    private var options: [QuestionAnswerOption] {
        let serverOptions = question.answer_options ?? []
        return serverOptions.isEmpty ? Self.defaultOptions : serverOptions
    }

    /// Amounts (e.g. "4 g") are the main answers and get a grid; the rest ("Nie podano", "Nie wiem") sit below them.
    private var amountOptions: [QuestionAnswerOption] {
        options.filter { $0.answer_type == .text }
    }

    private var otherOptions: [QuestionAnswerOption] {
        options.filter { $0.answer_type != .text }
    }

    private var canSendText: Bool {
        !isSubmitting && !textAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        // A question waits for the caregiver: shown as its own card, not as another assistant paragraph.
        VStack(alignment: .leading, spacing: 12) {
            Label("Pytanie do Ciebie", systemImage: "questionmark.bubble.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)

            Text(question.question_text)
                .font(.body.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)

            if !amountOptions.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 8)], alignment: .leading, spacing: 8) {
                    ForEach(amountOptions, id: \.self) { option in
                        optionButton(option, prominent: true)
                    }
                }
            }

            if !otherOptions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(otherOptions, id: \.self) { option in
                        optionButton(option, prominent: false)
                    }
                }
            }

            if question.expected_answer_types.contains(.text) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(amountOptions.isEmpty ? "Albo opisz krótko" : "Inna ilość lub opis", text: $textAnswer, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isSubmitting)

                    Button {
                        onSelect(.text)
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(canSendText ? Color.accentColor : Color.secondary)
                    .disabled(!canSendText)
                    .accessibilityLabel("Wyślij odpowiedź")
                }
            }
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

    @ViewBuilder
    private func optionButton(_ option: QuestionAnswerOption, prominent: Bool) -> some View {
        let button = Button {
            onSelectOption(option)
        } label: {
            Text(option.label)
                .frame(maxWidth: prominent ? .infinity : nil)
        }
        .disabled(isSubmitting)
        .accessibilityHint(option.answer_text ?? "")

        if prominent {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}

// MARK: - Agent status

/// The agent's current step as reported by the backend. While work runs it is one line with a light sweep
/// (as in ChatGPT) and a real elapsed time when the backend reported a start; the backend picks its tools as
/// it goes, so there is no honest list of steps to come. Stopping is the composer's stop button. A finished,
/// failed or cancelled run is a card.
struct AgentStatusView: View {
    let activity: ConversationViewModel.AgentActivity
    var notice: String? = nil
    /// "Spróbuj ponownie" only when the failed request can be repeated without duplicates; otherwise a refresh.
    var retryTitle = "Odśwież rozmowę"
    let onRetry: () -> Void

    var body: some View {
        Group {
            if activity.isActive {
                runningLine
            } else {
                resultCard
            }
        }
        .frame(maxWidth: 680, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(activity.isActive ? .updatesFrequently : [])
    }

    private var runningLine: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(activity.headline)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
                .shimmering()
                .animation(.easeInOut(duration: 0.25), value: activity.headline)

            if let startedAt = activity.startedAt {
                TimelineView(.periodic(from: startedAt, by: 1)) { context in
                    Text(Self.elapsedText(from: startedAt, to: context.date))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }

            if let notice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 6)
    }

    private var resultCard: some View {
        HStack(alignment: .top, spacing: 10) {
            icon
                .frame(width: 18, height: 18)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                Text(activity.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(activity.phase == .failed ? Color.red : Color.primary)
                    .fixedSize(horizontal: false, vertical: true)

                if let notice {
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if activity.phase == .failed {
                    Button(retryTitle, action: onRetry)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .padding(.top, 4)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(activity.phase == .failed ? Color.red.opacity(0.08) : Color.subtleFill)
        )
    }

    @ViewBuilder
    private var icon: some View {
        switch activity.phase {
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
        case .cancelled:
            Image(systemName: "stop.circle.fill")
                .foregroundStyle(.secondary)
        case .sending, .waiting, .analyzing, .usingTool, .generating:
            EmptyView()
        }
    }

    static func elapsedText(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        if seconds < 60 {
            return "\(seconds) s"
        }
        return String(format: "%d min %02d s", seconds / 60, seconds % 60)
    }
}

/// A band of light sweeping across secondary text, left to right. Static text with Reduce Motion.
private struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let period: TimeInterval = 1.8

    func body(content: Content) -> some View {
        if reduceMotion {
            content.foregroundStyle(.secondary)
        } else {
            TimelineView(.animation) { context in
                let progress = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: period) / period
                content
                    .foregroundStyle(.secondary)
                    .overlay {
                        content
                            .foregroundStyle(.primary)
                            .mask {
                                GeometryReader { proxy in
                                    let band = max(proxy.size.width * 0.45, 60)
                                    LinearGradient(colors: [.clear, .black, .clear], startPoint: .leading, endPoint: .trailing)
                                        .frame(width: band)
                                        .offset(x: -band + (proxy.size.width + band) * progress)
                                }
                            }
                    }
            }
        }
    }
}

extension View {
    public func shimmering() -> some View {
        modifier(Shimmer())
    }
}

// MARK: - Recommendation

private struct RecommendationView: View {
    let recommendation: RecommendationResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Sugestia", systemImage: "lightbulb")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(recommendation.proposal.title)
                .font(.headline)
            Text(recommendation.proposal.text)
                .font(.body)
            Text("Wsparcie decyzji — nic nie zmienia się automatycznie w leczeniu.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(12)
        .frame(maxWidth: 680, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.orange.opacity(0.08))
        )
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color.orange.opacity(0.6))
                .frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: 1.5))
                .padding(.vertical, 8)
        }
        .textSelection(.enabled)
    }
}

/// The scroll to a sent message starts while the composer and the rows around it still change (the sent text and
/// photos leave the composer, the echo becomes the stored message). Once they have settled, the same scroll puts the
/// turn exactly at the top (a no-op when it already is).
enum ScrollPinCorrection {
    static let delaysMilliseconds: [UInt64] = [350, 450]

    @MainActor
    static func settle(_ scroll: @escaping () -> Void) async {
        for delay in delaysMilliseconds {
            try? await Task.sleep(nanoseconds: delay * 1_000_000)
            if Task.isCancelled { return }
            withAnimation(.easeOut(duration: 0.15)) { scroll() }
        }
    }
}
