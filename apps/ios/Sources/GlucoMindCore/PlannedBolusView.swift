import Combine
import SwiftUI

@MainActor
public final class PlannedBolusViewModel: ObservableObject {
    @Published public private(set) var meal: MealDetail?
    @Published public private(set) var plan: PlannedBolusDetail?
    @Published public private(set) var isLoading = false
    @Published public private(set) var loaded = false
    @Published public private(set) var isSkipping = false
    @Published public var errorMessage: String?

    private let route: MealRoute
    private let api: PlannedBolusAPI
    private let now: () -> Date

    public init(route: MealRoute, api: PlannedBolusAPI, now: @escaping () -> Date = Date.init) {
        self.route = route
        self.api = api
        self.now = now
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await api.getMealPlannedBolus(patientID: route.patientID, mealID: route.mealID, plannedBolusID: route.plannedBolusID))
        } catch {
            errorMessage = "Nie udało się wczytać drugiej części bolusa."
        }
    }

    /// The other caregiver's send or skip, Trio's answer, the loop's insulin since the last read.
    public func refresh() async {
        guard let response = try? await api.getMealPlannedBolus(patientID: route.patientID, mealID: route.mealID, plannedBolusID: route.plannedBolusID) else { return }
        apply(response)
    }

    /// "Podaj": the dose from an estimate at most 2 min old (the Bolus tab's limit); an older one (the screen open a
    /// while, new SMBs since) is read again first. Nil when it cannot be read or the part can no longer be given.
    public func giveBase() async -> RemoteBolusDraftBase? {
        guard let plan else { return nil }
        if plan.estimateIsFresh(at: now()) { return plan.draftBase() }
        do {
            apply(try await api.getMealPlannedBolus(patientID: route.patientID, mealID: route.mealID, plannedBolusID: route.plannedBolusID))
        } catch {
            errorMessage = "Nie udało się przeliczyć dawki. Spróbuj ponownie."
            return nil
        }
        guard let fresh = self.plan, fresh.canGiveNow else { return nil }
        return fresh.draftBase()
    }

    public func skip() async {
        guard let plan else { return }
        isSkipping = true
        defer { isSkipping = false }
        do {
            apply(try await api.skipMealPlannedBolus(patientID: route.patientID, mealID: route.mealID, plannedBolusID: plan.id))
        } catch {
            errorMessage = error.remoteCommandRefusal ?? "Nie udało się wyłączyć tej części."
            await refresh()
        }
    }

    private func apply(_ response: PlannedBolusResponse) {
        meal = response.meal
        plan = response.planned_bolus
        loaded = true
    }
}

/// The second part of a split meal bolus (from its reminder or the meal page): the meal, the part given, and the dose
/// to give now with how it was computed. Either caregiver gives or skips it; the other phone sees it at once.
public struct PlannedBolusView: View {
    @Environment(\.loopSystem) private var loopSystem
    @StateObject private var viewModel: PlannedBolusViewModel
    @Environment(\.remoteBolusHost) private var remoteBolusHost
    @Environment(\.liveUpdates) private var liveUpdates
    /// "Wyłącz" waits for its confirmation: a part switched off cannot be switched on again.
    @State private var confirmsSkip = false
    private let onClose: () -> Void

    public init(route: MealRoute, api: PlannedBolusAPI, onClose: @escaping () -> Void) {
        _viewModel = StateObject(wrappedValue: PlannedBolusViewModel(route: route, api: api))
        self.onClose = onClose
    }

    public var body: some View {
        if let remoteBolusHost {
            remoteBolusHost.attach(AnyView(content))
        } else {
            content
        }
    }

    /// The plan as a bolus card: the deferred carbs and the dose now, or the sent ones with their progress.
    static func card(_ plan: PlannedBolusDetail, meal: MealDetail) -> ConversationBolusProposal {
        let sent = plan.command.map { !["EXPIRED", "SEND_FAILED"].contains($0.status) } ?? false
        return ConversationBolusProposal(
            id: "planned-\(plan.id)",
            purpose: "MEAL_PART",
            carbs_g: plan.carbs_g,
            insulin_u: plan.doseNow,
            icr_g_per_u: plan.estimate?.icr_g_per_u,
            icr_insulin_u: plan.estimate?.insulin_for_carbs_u,
            meal_description: meal.description.flatMap(MealNames.short),
            meal: nil,
            reason: reason(plan),
            warnings: plan.mealChangeNotice.map { [$0] } ?? [],
            expires_at: "9999-12-31T00:00:00Z",
            state: sent ? "SENT" : "PROPOSED",
            command: sent ? plan.command : nil
        )
    }

    /// "24 g / ICR 8 = 3 j. Pętla dodała od posiłku 0,4 j (SMB 0,3 j, baza +0,1 j), więc teraz 2,6 j."
    static func reason(_ plan: PlannedBolusDetail) -> String {
        if let fixed = plan.estimate?.fixed_insulin_u {
            return "Dawka ustalona w planie: \(RemoteCommandFormat.units(fixed)) j. Sprawdź glikemię i IOB przed podaniem."
        }
        guard let estimate = plan.estimate, let icr = estimate.icr_g_per_u, let forCarbs = estimate.insulin_for_carbs_u else {
            return "Nie udało się teraz przeliczyć dawki (brak ICR lub danych z pętli): to dawka z planu, \(RemoteCommandFormat.units(plan.planned_insulin_u)) j."
        }
        let doseCarbs = estimate.dose_carbs_g ?? plan.summary.doseCarbsG
        let cover = estimate.drop_cover_g ?? 0
        var text = cover > 0
            ? "(\(doseCarbs) g − \(cover) g na pokrycie spadku) / ICR \(RemoteCommandFormat.units(icr)) (przelicznik teraz) = \(RemoteCommandFormat.units(forCarbs)) j."
            : "\(doseCarbs) g / ICR \(RemoteCommandFormat.units(icr)) (przelicznik teraz) = \(RemoteCommandFormat.units(forCarbs)) j."
        if let given = estimate.first_insulin_subtracted_u, given > 0.004 {
            text += " Z karty podano już \(RemoteCommandFormat.units(given)) j na te węglowodany (odjęte)."
        }
        if let manual = estimate.manual_insulin_subtracted_u, manual > 0.004 {
            text += " Od posiłku podano już ręcznie \(RemoteCommandFormat.units(manual)) j (odjęte)."
        }
        if let extra = estimate.loop_extra_u {
            if extra > 0.004 {
                var parts: [String] = []
                if let smb = estimate.smb_u, smb > 0.004 { parts.append("SMB \(RemoteCommandFormat.units(smb)) j") }
                if let basal = estimate.temp_basal_extra_u, abs(basal) > 0.004 { parts.append("baza \(basal > 0 ? "+" : "−")\(RemoteCommandFormat.units(abs(basal))) j") }
                text += " Pętla dodała od posiłku \(RemoteCommandFormat.units(extra)) j ponad bazę\(parts.isEmpty ? "" : " (\(parts.joined(separator: ", ")))"), więc teraz \(RemoteCommandFormat.units(plan.doseNow)) j."
            } else {
                text += " Pętla nie dodała insuliny ponad bazę od posiłku."
            }
            if estimate.loop_extra_partial == true {
                text += " Bez profilu bazy nie widać zmian bazy (policzone tylko SMB): sprawdź IOB przed podaniem."
            }
        } else {
            text += " Bez profilu bazy nie widać, ile pętla dodała: sprawdź IOB przed podaniem."
        }
        return text
    }

    private var content: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let meal = viewModel.meal {
                        mealCard(meal)
                        if let plan = viewModel.plan {
                            SplitBolusTimeline(plan: plan.summary, firstAt: plan.meal_started_at.flatMap(ServerDate.parse))
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.secondary.opacity(0.08)))
                            if plan.summary.isOpen || plan.command != nil {
                                planCard(plan, meal: meal)
                            } else {
                                Label(plan.summary.statusLine, systemImage: plan.status == "GIVEN" ? "checkmark.circle.fill" : "minus.circle")
                                    .foregroundStyle(plan.status == "GIVEN" ? Color.green : Color.secondary)
                            }
                        } else if viewModel.loaded {
                            Text("Ten posiłek nie ma zaplanowanej dawki na później.")
                                .foregroundStyle(.secondary)
                        }
                        Text("Dawka to wsparcie decyzji. Sprawdź glikemię, trend i IOB; jeśli zjedzono mniej, zmniejsz węglowodany i dawkę albo pomiń. Decyzja należy do Ciebie.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if viewModel.isLoading {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding()
            }
            .navigationTitle(viewModel.plan?.isDeferred == true ? "Bolus na posiłek" : "Druga część bolusa")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij", action: onClose)
                }
            }
            .task { await viewModel.load() }
            // The other caregiver's send or skip and Trio's answer arrive live: the button disappears on both phones.
            .onReceive(liveUpdates?.changes.filter { $0.concerns(anyOf: ["remote_command", "meal", "meals"]) }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
                Task { await viewModel.refresh() }
            }
            .alert(
                viewModel.plan?.isDeferred == true ? "Bolus na posiłek" : "Druga część bolusa",
                isPresented: Binding(get: { viewModel.errorMessage != nil }, set: { if !$0 { viewModel.errorMessage = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(viewModel.errorMessage ?? "")
            }
        }
    }

    @ViewBuilder
    private func planCard(_ plan: PlannedBolusDetail, meal: MealDetail) -> some View {
        let canGive = plan.canGiveNow
        VStack(alignment: .leading, spacing: 10) {
            BolusProposalCard(
                proposal: Self.card(plan, meal: meal),
                // The dose is re-read first when its estimate is over 2 min old.
                onGive: canGive ? remoteBolusHost.map { host in { give(with: host) } } : nil,
                onRetry: plan.retryBase().flatMap { base in remoteBolusHost.map { host in { host.give(base) } } },
                onRecalculate: nil,
                onOpenMeal: nil
            )
            if canGive && remoteBolusHost == nil {
                Text(plan.isDeferred
                    ? "Podaj w \(loopSystem.names.locative) samą insulinę: \(RemoteCommandFormat.units(plan.doseNow)) j (węglowodany już tam są), a wpis przypisz jako dodatek do tego posiłku."
                    : "Podaj w \(loopSystem.names.locative): \(plan.carbs_g) g i \(RemoteCommandFormat.units(plan.doseNow)) j, a wpis przypisz jako dodatek do tego posiłku.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if canGive {
                // The same switch and confirmation as "Wyłącz" on the card's timeline.
                Button(role: .destructive) {
                    confirmsSkip = true
                } label: {
                    Label(plan.isDeferred ? "Wyłącz bolus" : "Wyłącz tę część", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.isSkipping)
                .confirmationDialog(CardDoseTimeline.skipTitle, isPresented: $confirmsSkip, titleVisibility: .visible) {
                    Button("Wyłącz \(RemoteCommandFormat.units(plan.doseNow)) j", role: .destructive) {
                        Task { await viewModel.skip() }
                    }
                    Button("Anuluj", role: .cancel) {}
                } message: {
                    Text(CardDoseTimeline.skipMessage)
                }
            } else if plan.summary.isOpen && plan.command == nil && plan.sending {
                Label(plan.isDeferred ? "Drugi opiekun wysyła ten bolus do \(loopSystem.names.genitive)." : "Drugi opiekun wysyła tę część do \(loopSystem.names.genitive).", systemImage: "paperplane")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func give(with host: RemoteBolusHost) {
        Task {
            if let base = await viewModel.giveBase() { host.give(base) }
        }
    }

    private func mealCard(_ meal: MealDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Posiłek o \(LoopFormat.time(meal.started_at))")
                .font(.headline)
            Text(meal.description?.isEmpty == false ? meal.description! : "Bez opisu")
                .foregroundStyle(meal.description?.isEmpty == false ? .primary : .secondary)
            Text(MealWbtView.macrosLine(meal))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.secondary.opacity(0.1)))
    }
}

/// The two parts of a split bolus on a small time line: the part given (or to give now) and the planned one with a
/// grey clock (green check once given).
struct SplitBolusTimeline: View {
    let firstTime: String
    let firstDetail: String
    let firstDone: Bool
    let secondTime: String
    let secondDetail: String
    /// GIVEN, SKIPPED … or nil while it is still planned.
    let secondStatus: String?
    let footnote: String?

    init(firstTime: String, firstDetail: String, firstDone: Bool, secondTime: String, secondDetail: String, secondStatus: String?, footnote: String?) {
        self.firstTime = firstTime
        self.firstDetail = firstDetail
        self.firstDone = firstDone
        self.secondTime = secondTime
        self.secondDetail = secondDetail
        self.secondStatus = secondStatus
        self.footnote = footnote
    }

    /// A plan that exists (the first part's meal was saved).
    init(plan: PlannedBolusSummary, firstAt: Date?) {
        if plan.isDeferred {
            // The meal's carbs went to Trio first; the whole dose waits until glucose stops falling.
            self.init(
                firstTime: firstAt.map(LoopFormat.clock) ?? "Posiłek",
                firstDetail: plan.first_insulin_u > 0 ? "\(RemoteCommandFormat.units(plan.first_insulin_u)) j · \(plan.first_carbs_g) g" : "\(plan.first_carbs_g) g · bez insuliny",
                firstDone: true,
                secondTime: plan.status == "NOTIFIED" || plan.status == "GIVEN" ? (plan.resolved_at.flatMap(ServerDate.parse).map(LoopFormat.clock) ?? "teraz") : LaterTriggerText.short(trigger: plan.laterTrigger, afterMinutes: plan.delay_minutes, thresholdMgdl: plan.threshold_mgdl),
                secondDetail: plan.status == "GIVEN"
                    ? "\(plan.given_insulin_u.map { "\(RemoteCommandFormat.units($0)) j" } ?? "podano")"
                    : "ok. \(RemoteCommandFormat.units(plan.planned_insulin_u)) j",
                secondStatus: plan.isOpen ? nil : plan.status,
                footnote: plan.statusLine
            )
            return
        }
        self.init(
            firstTime: firstAt.map(LoopFormat.clock) ?? "Podano",
            firstDetail: "\(RemoteCommandFormat.units(plan.first_insulin_u)) j · \(plan.first_carbs_g) g",
            firstDone: true,
            secondTime: plan.laterTrigger == "AFTER_MINUTES" || !plan.isOpen
                ? plan.dueDate.map(LoopFormat.clock) ?? "za \(plan.delay_minutes) min"
                : LaterTriggerText.short(trigger: plan.laterTrigger, afterMinutes: plan.delay_minutes, thresholdMgdl: plan.threshold_mgdl),
            secondDetail: plan.status == "GIVEN"
                ? "\(plan.given_insulin_u.map { "\(RemoteCommandFormat.units($0)) j" } ?? "podano") · \(plan.carbs_g) g"
                : "ok. \(RemoteCommandFormat.units(plan.planned_insulin_u)) j · \(plan.carbs_g) g",
            secondStatus: plan.isOpen ? nil : plan.status,
            footnote: plan.statusLine
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 0) {
                point(time: firstTime, detail: firstDetail) {
                    Image(systemName: firstDone ? "checkmark.circle.fill" : "syringe.fill")
                        .foregroundStyle(firstDone ? Color.green : Color.blue)
                }
                Rectangle()
                    .fill(Color.secondary.opacity(0.35))
                    .frame(height: 1.5)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 6)
                    .padding(.top, 9)
                point(time: secondTime, detail: secondDetail) {
                    Image(systemName: secondIcon)
                        .foregroundStyle(secondColor)
                }
            }
            if let footnote {
                Text(footnote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(firstTime) \(firstDetail), potem \(secondTime) \(secondDetail). \(footnote ?? "")")
    }

    private var secondIcon: String {
        switch secondStatus {
        case "GIVEN": return "checkmark.circle.fill"
        case nil: return "clock.fill"
        default: return "minus.circle"
        }
    }

    private var secondColor: Color {
        secondStatus == "GIVEN" ? .green : .secondary
    }

    private func point(time: String, detail: String, @ViewBuilder icon: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                icon().font(.subheadline)
                Text(time).font(.subheadline.weight(.semibold).monospacedDigit())
            }
            Text(detail)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .fixedSize()
    }
}
