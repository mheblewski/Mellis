import Combine
import SwiftUI

@MainActor
public final class MealWbtViewModel: ObservableObject {
    @Published public private(set) var meal: MealDetail?
    @Published public private(set) var suggestion: WbtSuggestion?
    /// The WBT sent to Trio from this window: its card shows the progress instead of the button.
    @Published public private(set) var remoteCommand: ConversationBolusProposal.SentCommand?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isRequesting = false
    /// The meal's WBT conversation, once "Porozmawiaj o dawce" opened it (wbt-chat.v1).
    @Published public var conversationID: String?
    @Published public private(set) var isOpeningConversation = false
    @Published public var errorMessage: String?

    private let route: MealRoute
    private let api: MealWbtAPI
    /// Polling of a PENDING suggestion: every 2 s, at most 90 s.
    private let pollInterval: UInt64
    private let maxPolls: Int

    public init(route: MealRoute, api: MealWbtAPI, pollInterval: UInt64 = 2_000_000_000, maxPolls: Int = 45) {
        self.route = route
        self.api = api
        self.pollInterval = pollInterval
        self.maxPolls = maxPolls
    }

    public var isPending: Bool { suggestion?.status == "PENDING" }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await api.getMealWbtSuggestion(patientID: route.patientID, mealID: route.mealID))
            if isPending { await poll() }
        } catch {
            errorMessage = "Nie udało się wczytać posiłku."
        }
    }

    public func requestSuggestion() async {
        isRequesting = true
        defer { isRequesting = false }
        do {
            apply(try await api.requestMealWbtSuggestion(patientID: route.patientID, mealID: route.mealID))
            await poll()
        } catch {
            errorMessage = "Nie udało się poprosić o propozycję dawki."
        }
    }

    private func poll() async {
        var polls = 0
        while isPending, polls < maxPolls, !Task.isCancelled {
            polls += 1
            try? await Task.sleep(nanoseconds: pollInterval)
            guard let response = try? await api.getMealWbtSuggestion(patientID: route.patientID, mealID: route.mealID) else { continue }
            apply(response)
        }
    }

    private func apply(_ response: MealWbtSuggestionResponse) {
        meal = response.meal
        suggestion = response.suggestion
        remoteCommand = response.remote_command
    }

    /// Opens the meal's WBT conversation (created on first use): the chat talks the dose over and may propose another.
    public func openConversation() async {
        isOpeningConversation = true
        defer { isOpeningConversation = false }
        do {
            conversationID = try await api.openMealWbtConversation(patientID: route.patientID, mealID: route.mealID).conversation_id
        } catch {
            errorMessage = "Nie udało się otworzyć rozmowy o dawce."
        }
    }

    /// The command's progress (Trio's answer, the WBT saved to the meal) without asking for a new suggestion.
    public func refresh() async {
        guard let response = try? await api.getMealWbtSuggestion(patientID: route.patientID, mealID: route.mealID) else { return }
        apply(response)
    }
}

/// WBT insulin screen (from the reminder 2.5 h after a meal): the meal, then on request the AI dose proposal with its
/// rationale and the personal history it used (shown only with enough history).
public struct MealWbtView: View {
    @StateObject private var viewModel: MealWbtViewModel
    @Environment(\.remoteBolusHost) private var remoteBolusHost
    @Environment(\.liveUpdates) private var liveUpdates
    private let route: MealRoute
    private let onClose: () -> Void
    /// The chat's client; nil where the API is not the app's (previews, tests): no "Porozmawiaj o dawce".
    private let conversationClient: APIClient?

    public init(route: MealRoute, api: MealWbtAPI, onClose: @escaping () -> Void) {
        _viewModel = StateObject(wrappedValue: MealWbtViewModel(route: route, api: api))
        self.route = route
        self.onClose = onClose
        self.conversationClient = api as? APIClient
    }

    public var body: some View {
        if let remoteBolusHost {
            remoteBolusHost.attach(AnyView(content))
        } else {
            content
        }
    }

    /// The carbs-equivalent and the dose to Trio as this meal's WBT; both can be changed in the confirmation.
    static func wbtBase(_ result: WbtSuggestionResult, mealID: String) -> RemoteBolusDraftBase? {
        guard result.dose_units > 0 else { return nil }
        return RemoteBolusDraftBase(
            source: .wbtScreen,
            carbsG: Int((result.carbs_equivalent_g ?? 0).rounded()),
            insulinU: Decimal(string: String(format: "%.2f", result.dose_units), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(result.dose_units),
            wbtMealID: mealID
        )
    }

    /// The WBT suggestion as a bolus card (purpose WBT): the proposed amounts, or the sent ones with their progress.
    static func wbtCard(_ result: WbtSuggestionResult, meal: MealDetail, command: ConversationBolusProposal.SentCommand?) -> ConversationBolusProposal? {
        guard result.dose_units > 0 else { return nil }
        let sent = command.map { !["EXPIRED", "SEND_FAILED"].contains($0.status) } ?? false
        return ConversationBolusProposal(
            id: "wbt-\(meal.meal_id)",
            purpose: "WBT",
            carbs_g: Int((result.carbs_equivalent_g ?? 0).rounded()),
            insulin_u: result.dose_units,
            icr_g_per_u: nil,
            icr_insulin_u: nil,
            meal_description: meal.description,
            meal: nil,
            reason: result.rationale,
            warnings: [],
            expires_at: "9999-12-31T00:00:00Z",
            state: sent ? "SENT" : "PROPOSED",
            command: sent ? command : nil
        )
    }

    /// A WBT conversation's dose as a bolus card (purpose WBT, wbt-chat.v1): proposed, or sent with its progress.
    static func chatCard(_ proposal: ConversationWbtProposal) -> ConversationBolusProposal? {
        guard proposal.dose_units > 0 else { return nil }
        let sent = proposal.command.map { !["EXPIRED", "SEND_FAILED"].contains($0.status) } ?? false
        return ConversationBolusProposal(
            id: "wbt-chat-\(proposal.suggestion_id)",
            purpose: "WBT",
            carbs_g: Int((proposal.carbs_equivalent_g ?? 0).rounded()),
            insulin_u: proposal.dose_units,
            icr_g_per_u: nil,
            icr_insulin_u: nil,
            meal_description: nil,
            meal: nil,
            reason: proposal.rationale,
            warnings: (proposal.warnings ?? []).map { RemoteCommandNotice(code: "WBT_CHAT", key: nil, message: $0) },
            expires_at: "9999-12-31T00:00:00Z",
            state: sent ? "SENT" : "PROPOSED",
            command: sent ? proposal.command : nil
        )
    }

    /// The conversation's dose to Trio as its meal's WBT: the WBT screen's path and checks.
    static func chatBase(_ proposal: ConversationWbtProposal) -> RemoteBolusDraftBase? {
        guard proposal.dose_units > 0 else { return nil }
        return RemoteBolusDraftBase(
            source: .wbtScreen,
            carbsG: Int((proposal.carbs_equivalent_g ?? 0).rounded()),
            insulinU: Decimal(string: String(format: "%.2f", proposal.dose_units), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(proposal.dose_units),
            wbtMealID: proposal.meal_id
        )
    }

    /// Trio refused the WBT: the insulin alone when it kept the carbs (PARTIAL), both otherwise.
    static func wbtRetryBase(_ command: ConversationBolusProposal.SentCommand?, mealID: String) -> RemoteBolusDraftBase? {
        guard let command, command.retry_until != nil, command.status == "PARTIAL" || command.status == "REJECTED" else { return nil }
        let carbsKept = command.status == "PARTIAL"
        return RemoteBolusDraftBase(
            source: .wbtScreen,
            carbsG: carbsKept ? 0 : command.carbs_g,
            insulinU: Decimal(string: String(format: "%.2f", command.insulin_u), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(command.insulin_u),
            wbtMealID: mealID
        )
    }

    private var content: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let meal = viewModel.meal {
                        mealCard(meal)
                        if let suggestion = viewModel.suggestion {
                            suggestionView(suggestion)
                        }
                        if viewModel.suggestion?.status == "DONE", conversationClient != nil {
                            // wbt-chat.v1: the dose talked over in a chat that may propose another one.
                            Button {
                                Task { await viewModel.openConversation() }
                            } label: {
                                Label("Porozmawiaj o dawce", systemImage: "bubble.left.and.text.bubble.right")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .disabled(viewModel.isOpeningConversation)
                        }
                        if !viewModel.isPending {
                            Button {
                                Task { await viewModel.requestSuggestion() }
                            } label: {
                                Label(viewModel.suggestion?.status == "DONE" ? "Zaproponuj ponownie" : "Zaproponuj dawkę", systemImage: "syringe")
                                    .frame(maxWidth: .infinity)
                            }
                            .modifier(ProminentUnless(viewModel.suggestion?.status == "DONE"))
                            .controlSize(.large)
                            .disabled(viewModel.isRequesting)
                        }
                        Text("Propozycja to wsparcie decyzji. Przed podaniem sprawdź glikemię i trend; decyzja należy do Ciebie.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if viewModel.isLoading {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding()
            }
            .navigationTitle("Insulina na WBT")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij", action: onClose)
                }
            }
            .task { await viewModel.load() }
            .navigationDestination(isPresented: Binding(get: { viewModel.conversationID != nil }, set: { if !$0 { viewModel.conversationID = nil } })) {
                if let conversationClient, let conversationID = viewModel.conversationID {
                    WbtConversationScreen(apiClient: conversationClient, patientID: route.patientID, conversationID: conversationID, onGiveBolus: remoteBolusHost?.give)
                }
            }
            // Back from the chat: its dose may be the newest suggestion now.
            .onChange(of: viewModel.conversationID) { _, id in
                if id == nil { Task { await viewModel.refresh() } }
            }
            // The command's answer and the WBT saved to the meal arrive live.
            .onReceive(liveUpdates?.changes.filter { $0.concerns(anyOf: ["remote_command", "meals"]) }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
                Task { await viewModel.refresh() }
            }
            .alert(
                "Insulina na WBT",
                isPresented: Binding(get: { viewModel.errorMessage != nil }, set: { if !$0 { viewModel.errorMessage = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(viewModel.errorMessage ?? "")
            }
        }
    }

    private func mealCard(_ meal: MealDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Posiłek o \(LoopFormat.time(meal.started_at))")
                .font(.headline)
            Text(meal.description?.isEmpty == false ? meal.description! : "Bez opisu")
                .foregroundStyle(meal.description?.isEmpty == false ? .primary : .secondary)
            Text(Self.macrosLine(meal))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.secondary.opacity(0.1)))
    }

    @ViewBuilder
    private func suggestionView(_ suggestion: WbtSuggestion) -> some View {
        switch suggestion.status {
        case "PENDING":
            HStack(spacing: 8) {
                ProgressView()
                Text("Liczę dawkę na WBT… (zwykle do pół minuty)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        case "DONE":
            if let result = suggestion.result {
                if let remoteBolusHost, let meal = viewModel.meal, let card = Self.wbtCard(result, meal: meal, command: viewModel.remoteCommand) {
                    // The same card as a chat's bolus card: the dose, then Wysłano → Podany → WBT once sent.
                    VStack(alignment: .leading, spacing: 10) {
                        BolusProposalCard(
                            proposal: card,
                            onGive: Self.wbtBase(result, mealID: route.mealID).map { base in { remoteBolusHost.give(base) } },
                            onRetry: Self.wbtRetryBase(viewModel.remoteCommand, mealID: route.mealID).map { base in { remoteBolusHost.give(base) } },
                            onRecalculate: nil,
                            onOpenMeal: nil
                        )
                        historyNote(result)
                    }
                } else {
                    answerCard(result)
                }
            }
        default:
            Label("Nie udało się przygotować propozycji. Spróbuj ponownie.", systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.orange)
        }
    }

    private func answerCard(_ result: WbtSuggestionResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                (Text("Propozycja dawki: ").bold() + Text(LoopFormat.units(result.dose_units)))
                    .font(.title3)
                if let carbs = result.carbs_equivalent_g, result.dose_units > 0 {
                    Text("W pętli to ok. \(LoopFormat.number(carbs)) g węglowodanów (jako WBT).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            (Text("Uzasadnienie: ").bold() + Text(result.rationale))
            historyNote(result)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.accentColor.opacity(0.1)))
    }

    /// Where the dose comes from: the standard rule, no personal history of earlier meals.
    private func historyNote(_ result: WbtSuggestionResult) -> some View {
        Text("Dawka standardowa: 30% insuliny na 10 g węglowodanów na każde WBT.")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    static func macrosLine(_ meal: MealDetail) -> String {
        var parts = [LoopFormat.macros(meal.macros)]
        if let units = meal.wbt?.fat_protein_units {
            parts.append("\(LoopFormat.number(units)) WBT")
        }
        return parts.joined(separator: " · ")
    }
}

/// "Zaproponuj ponownie" steps back once there is a dose to give.
private struct ProminentUnless: ViewModifier {
    let plain: Bool
    init(_ plain: Bool) { self.plain = plain }

    func body(content: Content) -> some View {
        if plain {
            content.buttonStyle(.bordered)
        } else {
            content.buttonStyle(.borderedProminent)
        }
    }
}

/// The meal's WBT conversation inside the WBT window (wbt-chat.v1): the same chat as in Rozmowy, its cards given from here.
struct WbtConversationScreen: View {
    @StateObject private var viewModel: ConversationViewModel
    private let conversationID: String
    private let onGiveBolus: ((RemoteBolusDraftBase) -> Void)?

    init(apiClient: APIClient, patientID: String, conversationID: String, onGiveBolus: ((RemoteBolusDraftBase) -> Void)?) {
        _viewModel = StateObject(wrappedValue: ConversationViewModel(apiClient: apiClient, patientID: patientID, conversationID: conversationID))
        self.conversationID = conversationID
        self.onGiveBolus = onGiveBolus
    }

    var body: some View {
        ConversationView(viewModel: viewModel, conversationID: conversationID, onGiveBolus: onGiveBolus)
            .navigationTitle("Rozmowa o WBT")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
    }
}
