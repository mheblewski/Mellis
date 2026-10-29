import Charts
import SwiftUI

/// A bolus card under a chat answer (remote-bolus-trio-plan.md W7): the dose the AI prepared, given with one tap after
/// the confirmation and Face ID.
public struct ConversationBolusProposal: Codable, Equatable, Identifiable {
    public struct SentCommand: Codable, Equatable {
        public let id: String
        public let status: String
        public let status_message: String?
        public let carbs_g: Int
        public let insulin_u: Double
        public let meal_record_id: String?
        public let sent_by_me: Bool
        /// Trio refused it: the card offers it again (the bolus alone after PARTIAL) until then.
        public var retry_until: String? = nil
        /// SAVED, SAVING, NOT_FOUND or NONE (absent on older servers: decided from meal_record_id).
        public var meal_state: String? = nil
        /// A retry of a refused command (absent on older servers).
        public var follows_command_id: String? = nil
        /// When the caregiver confirmed it (absent on older servers).
        public var authorized_at: String? = nil
    }

    /// Why the dose is below carbs / ICR: glucose is falling, so part of the meal covers the drop.
    public struct DoseAdjustment: Codable, Equatable {
        /// One sentence for the card ("Trio prognozuje spadek do 70 mg/dL (cel 100), więc 6 g z posiłku pokryje spadek…").
        public let summary: String
        public let reduced_by_u: Double
        public let covered_carbs_g: Int
        public let forecast_low_mgdl: Int
        public let target_mgdl: Int
    }

    /// The forecast with exactly this card's carbs and insulin (card-advice.v1): its lowest point and when.
    public struct Risk: Codable, Equatable {
        public let min_mgdl: Int
        public let min_in_minutes: Int
        /// NONE, LOW (below 70) or VERY_LOW (below 54)
        public let level: String
        public let baseline_min_mgdl: Int

        public var isRisky: Bool { level == "LOW" || level == "VERY_LOW" }
    }

    /// The correction on the card, asked for by the caregiver: its dose and arithmetic.
    public struct Correction: Codable, Equatable {
        public let dose_u: Double
        /// "(248 − 100) / 60 − IOB 0,5 j = 1,95 j"
        public let breakdown: String
    }

    public let id: String
    /// MEAL, CORRECTION or PRE_BOLUS
    public let purpose: String
    public let carbs_g: Int
    public let insulin_u: Double
    public let icr_g_per_u: Double?
    public let icr_insulin_u: Double?
    public let meal_description: String?
    public let meal: RemoteCommandMeal?
    public let reason: String?
    public let warnings: [RemoteCommandNotice]
    public let expires_at: String
    /// PROPOSED, EXPIRED or SENT
    public let state: String
    public let command: SentCommand?
    /// The meal divided: this card gives carbs_g / insulin_u now, the rest is planned (absent: one bolus).
    public var split: SplitBolusPlan? = nil
    /// The planned second part once the first part's meal was saved.
    public var planned_bolus: PlannedBolusSummary? = nil
    /// The dose lowered for a falling glucose (absent: carbs / ICR, or an older server).
    public var dose_adjustment: DoseAdjustment? = nil
    /// The forecast low of this card (absent: no fresh reading, or an older server).
    public var risk: Risk? = nil
    /// The glucose with the card's whole plan, behind the chart button (card-forecast.v1; absent on older cards).
    public var forecast_chart: CardForecastChart? = nil
    /// The correction the caregiver asked for on this card (absent: none).
    public var correction: Correction? = nil
    /// Every later part this card planned once its meal was saved (absent: none or an older server).
    public var planned_parts: [PlannedBolusSummary]? = nil
    /// The WBT reminder of the meal this card saved (absent: none).
    public var wbt_reminder: CardWbtReminder? = nil
    /// The meal's WBT and whether its reminder will be set on its own (absent: no protein or fat known).
    public var wbt_plan: WbtPlan? = nil
    /// The answer's option the card belongs to (A-C; absent without options and on older servers).
    public var option_key: String? = nil
    /// When the card was computed (absent on older servers).
    public var created_at: String? = nil

    public struct WbtPlan: Codable, Equatable {
        public let units: Double
        public let standard_dose_u: Double?
        public let auto: Bool
        public let after_minutes: Int
    }

    public struct CardWbtReminder: Codable, Equatable {
        public let meal_id: String
        public let remind_at: String
        /// SCHEDULED, SENT or SKIPPED
        public let status: String
        public let enabled: Bool
        public var source: String? = nil
        /// The WBT insulin given for the meal (absent: none yet, or an older server).
        public var given_units: Double? = nil

        /// It has not come yet and can be switched off (or on again).
        public var isPending: Bool { status == "SCHEDULED" }
    }

    /// The retry of the refused command: the bolus alone when Trio kept the carbs (PARTIAL), the whole dose otherwise.
    public func retryBase(conversationID: String) -> RemoteBolusDraftBase? {
        guard let command, command.retry_until != nil, command.status == "PARTIAL" || command.status == "REJECTED" else { return nil }
        let carbsKept = command.status == "PARTIAL"
        return RemoteBolusDraftBase(
            source: .chatCard,
            carbsG: carbsKept ? 0 : command.carbs_g,
            insulinU: Decimal(string: String(format: "%.2f", command.insulin_u), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(command.insulin_u),
            conversationID: conversationID,
            proposalID: id,
            meal: carbsKept ? nil : meal,
            followsCommandID: command.id
        )
    }

    /// The card's own dose may be given: nothing sent yet, or a send that never left. Never from a retry whose send
    /// failed: Trio refused the dose before it (and may have kept its carbs), so only that refusal's retry may go (the
    /// server shows the refusal on the card; an older server showed the failed retry).
    public var canGiveDraft: Bool {
        command?.follows_command_id == nil
    }

    /// When the card stops being valid (nil: unreadable).
    public var expiresAt: Date? { ServerDate.parse(expires_at) }

    /// The state as of `now`: a PROPOSED card past its validity is EXPIRED before the server's next answer says so.
    public func state(at now: Date) -> String {
        if state == "PROPOSED", let expiresAt, expiresAt <= now { return "EXPIRED" }
        return state
    }

    /// The values the confirmation opens with.
    public func draftBase(conversationID: String) -> RemoteBolusDraftBase {
        var base = RemoteBolusDraftBase(
            source: .chatCard,
            carbsG: carbs_g,
            insulinU: Decimal(string: String(format: "%.2f", insulin_u), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(insulin_u),
            conversationID: conversationID,
            proposalID: id,
            meal: carbs_g > 0 ? meal : nil,
            cardWarnings: warnings
        )
        base.proposalExpiresAt = expiresAt
        return base
    }
}

/// One step of a sent card's progress: Wysłano → Podano → Zapisano.
public struct BolusProgressStep: Equatable, Identifiable {
    public enum State: Equatable {
        case waiting, active, done, failed, unknown
    }

    public let title: String
    public let state: State
    public var id: String { title }
}

public extension ConversationBolusProposal {
    /// The amounts on the card: what was sent once a command went out (the caregiver may have changed them).
    var shownCarbsG: Int { command?.carbs_g ?? carbs_g }
    var shownInsulinU: Double { command?.insulin_u ?? insulin_u }

    /// "ICR 8 → 2,5 j + 0,3 j": the carbs' dose by the ratio and how far the proposed dose is from it.
    var doseBreakdown: String? {
        // A deferred bolus has no dose now: the timeline shows the later one.
        guard carbs_g > 0, split?.isDeferred != true, let icr = icr_g_per_u, let fromICR = icr_insulin_u else { return nil }
        var text = "ICR \(RemoteCommandFormat.units(icr)) → \(RemoteCommandFormat.units(fromICR)) j"
        let difference = (insulin_u - fromICR) * 100
        if abs(difference.rounded()) >= 5 {
            let units = RemoteCommandFormat.units(abs(difference.rounded()) / 100)
            text += difference > 0 ? " + \(units) j" : " − \(units) j"
        }
        return text
    }

    /// Sent, given (or stored in the loop for carbs alone), and the meal saved from it when there were carbs.
    func progressSteps(loop: LoopSystemNames) -> [BolusProgressStep] {
        guard let command else { return [] }
        let status = command.status
        let sent: BolusProgressStep.State = switch status {
        case "AUTHORIZED": .active
        case "SEND_FAILED", "EXPIRED": .failed
        default: .done
        }
        let given: BolusProgressStep.State = switch status {
        case "SUCCEEDED": .done
        case "REJECTED", "PARTIAL": .failed
        case "NO_REPLY": .unknown
        case "SENT", "TRIO_ACCEPTED": .active
        default: .waiting
        }
        var steps = [
            BolusProgressStep(title: "Wysłano", state: sent),
            BolusProgressStep(title: command.insulin_u > 0 ? "Podano" : "W \(loop.locative)", state: given),
        ]
        if command.carbs_g > 0 || purpose == "WBT" {
            let meal: BolusProgressStep.State
            if command.meal_record_id != nil || command.meal_state == "SAVED" {
                meal = .done
            } else if command.meal_state == "SAVING" {
                meal = .active
            } else if command.meal_state == "NOT_FOUND" {
                meal = .unknown
            } else {
                meal = .waiting
            }
            steps.append(BolusProgressStep(title: "Zapisano", state: meal))
        }
        return steps
    }
}

struct BolusProposalCard: View {
    /// The loop the card's dose goes to, by name (Trio, Loop).
    @Environment(\.loopSystem) private var loopSystem
    private var loop: LoopSystemNames { loopSystem.names }
    let proposal: ConversationBolusProposal
    /// Nil when this caregiver cannot send remote commands: the card shows the dose without the button.
    let onGive: (() -> Void)?
    /// Opens the confirmation for the refused dose (nil without remote commands or past the retry window).
    let onRetry: (() -> Void)?
    let onRecalculate: (() -> Void)?
    let onOpenMeal: ((String) -> Void)?
    /// Switches off a planned later part (nil: no switch).
    var onSkipPart: ((PlannedBolusSummary) -> Void)? = nil
    /// Switches the meal's WBT reminder off or on (nil: no switch).
    var onSetWbtReminder: ((String, Bool) -> Void)? = nil
    /// Timeline switches being saved: their buttons wait.
    var busySwitches: Set<String> = []

    /// Inside an option of the answer: no frame of its own and no forecast in the header (the option shows it).
    var embedded = false
    /// Steps drawn before this card's own on its timeline (an option's rescue carbs: one plan, one line).
    var leadingSteps: [CardTimelineStep] = []
    /// A button above this card's own (the rescue carbs' "Podano 7 g").
    var leadingAction: AnyView? = nil

    @State private var showsDetails = false
    @State private var showsChart = false

    var body: some View {
        // Redrawn just after the card expires: [Podaj] turns into "Przelicz" without waiting for the next refresh. The
        // state is read from the clock, not from context.date: an explicit schedule hands its first entry's date (the
        // expiry) to the very first render too, which showed a fresh card as expired.
        TimelineView(.explicit(proposal.state == "PROPOSED" ? proposal.expiresAt.map { [$0.addingTimeInterval(1)] } ?? [] : [])) { _ in
            card(state: proposal.state(at: Date()))
        }
    }

    private func card(state: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(state: state)

            // The whole plan: now, every later part and the WBT reminder, each with its switch once the meal is saved.
            CardDoseTimeline(steps: leadingSteps + proposal.timelineSteps(loop: loop), onAction: timelineAction, busySwitches: busySwitches)
                .opacity(state == "EXPIRED" ? 0.5 : 1)
                .padding(.top, embedded ? 6 : 10)

            if state == "PROPOSED" {
                if let risk = proposal.risk, risk.isRisky {
                    riskBox(risk)
                        .padding(.top, 10)
                }
                // Only what must not wait for "ⓘ" (e.g. a dose just given); the forecast is in the box above.
                ForEach(urgentWarnings, id: \.self) { warning in
                    Label(warning.message, systemImage: "exclamationmark.octagon.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.top, 8)
                }
            }

            if let leadingAction {
                leadingAction
                    .padding(.top, 12)
            }

            footer(state: state)

            if showsChart, let chart = proposal.forecast_chart {
                CardForecastChartView(chart: chart)
                    .padding(.top, 10)
                    .transition(.opacity)
            }

            if showsDetails {
                details
                    .padding(.top, 10)
                    .transition(.opacity)
            }

            if state == "PROPOSED", let validity {
                Text(validity)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            }
        }
        .padding(.horizontal, embedded ? 0 : 15)
        .padding(.vertical, embedded ? 0 : 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(embedded ? Color.clear : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(embedded ? Color.clear : Color.secondary.opacity(0.18), lineWidth: 1))
    }

    /// "Bolus na posiłek · Cheeseburger" and, on its own card, the forecast low of this plan.
    /// The timeline's icons say what each step is, so the header has none; inside an option only the meal's name.
    @ViewBuilder
    private func header(state: String) -> some View {
        if embedded {
            if let description = proposal.meal_description, !description.isEmpty {
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        } else {
            fullHeader(state: state)
        }
    }

    private func fullHeader(state: String) -> some View {
        HStack(alignment: .center, spacing: 8) {
            (Text(title).font(.subheadline.weight(.semibold))
                + Text(proposal.meal_description.map { $0.isEmpty ? "" : " · \($0)" } ?? "").font(.subheadline).foregroundColor(.secondary))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            if !embedded, state == "PROPOSED", let risk = proposal.risk {
                ForecastLabel(minimum: risk.min_mgdl)
            }
        }
    }

    /// "Prognoza: min. ok. 55 mg/dL za ok. 30 min": orange below 70, red below 54, always as a forecast.
    private func riskBox(_ risk: ConversationBolusProposal.Risk) -> some View {
        let color = ForecastLabel.color(risk.min_mgdl)
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: risk.level == "VERY_LOW" ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
            VStack(alignment: .leading, spacing: 1) {
                Text("Prognoza: min. ok. \(risk.min_mgdl) mg/dL za ok. \(risk.min_in_minutes) min")
                    .font(.footnote.weight(.medium))
                Text("zakłada, że pętla nic więcej nie zrobi")
                    .font(.caption2)
                    .opacity(0.8)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(color.opacity(0.13), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    /// Danger warnings other than the forecast (that one has its box): shown on the card, the rest under "ⓘ".
    private var urgentWarnings: [RemoteCommandNotice] {
        proposal.warnings.filter { $0.isDanger && $0.code != "FORECAST_LOW" }
    }

    /// The arithmetic and every reason, on demand.
    private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let breakdown = proposal.doseBreakdown {
                Text(breakdown).font(.footnote.monospacedDigit())
            }
            if let adjustment = proposal.dose_adjustment {
                Text(adjustment.summary)
            }
            if let correction = proposal.correction {
                Text("Korekta: \(correction.breakdown)").monospacedDigit()
            }
            if let reason = proposal.reason, !reason.isEmpty {
                Text(reason)
            }
            if proposal.split != nil {
                Text("Dawki później przeliczę w chwili przypomnienia (ICR wtedy, minus to, co dodała pętla). Przypomnienia przychodzą do obojga opiekunów.")
            }
            if let plan = proposal.wbt_plan {
                Text("WBT \(LoopFormat.number(plan.units)) · dawka = WBT × 10 / ICR × 30%.")
            }
            ForEach(proposal.warnings.filter { !urgentWarnings.contains($0) }, id: \.self) { warning in
                Label(warning.message, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// "z 15:31 · ważna do 15:46": how fresh the data behind the card are.
    private var validity: String? {
        // The WBT window and the planned part build cards that never expire: no line there.
        guard let expires = ServerDate.parse(proposal.expires_at), expires.timeIntervalSinceNow < 24 * 3600 else { return nil }
        let made = proposal.created_at.flatMap(ServerDate.parse)
        return [made.map { "dane z \(LoopFormat.clock($0))" }, "ważna do \(LoopFormat.clock(expires))"].compactMap { $0 }.joined(separator: " · ")
    }

    /// The plan's glucose chart, folded until asked for (owner 2026-10-23); none on cards without one.
    @ViewBuilder
    private var chartButton: some View {
        if proposal.forecast_chart != nil {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { showsChart.toggle() }
            } label: {
                Image(systemName: "chart.xyaxis.line")
                    .font(.body)
                    .foregroundStyle(showsChart ? Color.accentColor : Color.secondary)
                    .frame(width: 40, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showsChart ? "Ukryj wykres" : "Wykres glukozy z planem")
        }
    }

    private var detailsButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { showsDetails.toggle() }
        } label: {
            Image(systemName: showsDetails ? "info.circle.fill" : "info.circle")
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(showsDetails ? "Ukryj szczegóły" : "Szczegóły dawki")
    }

    /// "Podaj 2 j · 23 g", "Podaj 1,5 j" or "Wyślij 23 g do Trio" (the patient's loop): what the button sends.
    private var giveTitle: String {
        let units = RemoteCommandFormat.units(proposal.insulin_u)
        if proposal.insulin_u <= 0 { return "Wyślij \(proposal.carbs_g) g do \(loop.genitive)" }
        return proposal.carbs_g > 0 ? "Podaj \(units) j · \(proposal.carbs_g) g" : "Podaj \(units) j"
    }

    private var timelineAction: ((CardTimelineStep.Action) -> Void)? {
        guard onSkipPart != nil || onSetWbtReminder != nil else { return nil }
        return { action in
            switch action {
            case .skipPart(let part): onSkipPart?(part)
            case .setWbtReminder(let mealID, let enabled): onSetWbtReminder?(mealID, enabled)
            case .setMealReminder: break
            }
        }
    }

    @ViewBuilder
    private func footer(state: String) -> some View {
        switch state {
        case "SENT":
            if let command = proposal.command {
                sent(command)
            }
        case "EXPIRED":
            VStack(alignment: .leading, spacing: 8) {
                Text(ServerDate.parse(proposal.expires_at).map { "Nieaktualna od \(LoopFormat.clock($0)): glukoza i IOB mogły się zmienić." } ?? "Nieaktualna: glukoza i IOB mogły się zmienić.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 4) {
                    if let onRecalculate {
                        Button(action: onRecalculate) {
                            Label("Przelicz na aktualnych danych", systemImage: "arrow.clockwise")
                                .fontWeight(.semibold)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    } else {
                        Spacer()
                    }
                    chartButton
                    detailsButton
                }
            }
            .padding(.top, 12)
        default:
            HStack(spacing: 4) {
                if let onGive {
                    Button(action: onGive) {
                        Label(giveTitle, systemImage: "paperplane.fill")
                            .fontWeight(.semibold)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                } else {
                    Spacer()
                }
                chartButton
                detailsButton
            }
            .padding(.top, 12)
        }
    }

    @ViewBuilder
    private func sent(_ command: ConversationBolusProposal.SentCommand) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            BolusProgressBar(steps: proposal.progressSteps(loop: loop))

            Text(statusLine(command))
                .font(.footnote)
                .foregroundStyle(statusColor(command.status))
            if !command.sent_by_me {
                Text("Wysłane przez drugiego opiekuna").font(.caption).foregroundStyle(.secondary)
            }
            if command.meal_record_id == nil && command.meal_state == "NOT_FOUND" {
                Label(proposal.purpose == "WBT" ? "WBT nie zapisało się automatycznie: sprawdź wpis w posiłku." : "Posiłek nie zapisał się automatycznie: sprawdź zakładkę Posiłki.", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if let onRetry {
                Button(action: onRetry) {
                    Label(command.status == "PARTIAL" ? "Podaj sam bolus" : "Podaj ponownie", systemImage: "arrow.clockwise")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                if command.status == "PARTIAL" {
                    Text("Węglowodany są już w \(loop.locative): wyślę samą insulinę. Możesz zmienić dawkę przed podaniem.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let mealID = command.meal_record_id, let onOpenMeal {
                Button {
                    onOpenMeal(mealID)
                } label: {
                    Label("Otwórz posiłek", systemImage: "fork.knife")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.top, 12)
    }

    /// The command's own words, with the meal being saved after a given bolus.
    private func statusLine(_ command: ConversationBolusProposal.SentCommand) -> String {
        let message = command.status_message ?? (command.status == "AUTHORIZED" ? "Wysyłanie…" : "Polecenie wysłane, czekam na \(loop.genitive)")
        if command.meal_record_id == nil && command.meal_state == "SAVING" && command.status == "SUCCEEDED" {
            return "\(message) · \(proposal.purpose == "WBT" ? "zapisywanie WBT…" : "zapisywanie posiłku…")"
        }
        return message
    }

    private var title: String {
        if proposal.purpose == "MEAL_PART" { return proposal.carbs_g == 0 ? "Bolus na posiłek" : "Kolejna część bolusa" }
        if proposal.split?.isDeferred == true { return proposal.insulin_u > 0 ? "Bolus teraz i później" : "Węglowodany teraz, bolus później" }
        if proposal.purpose == "WBT" { return "Insulina na WBT" }
        if proposal.insulin_u == 0 { return "Węglowodany do \(loop.genitive)" }
        switch proposal.purpose {
        case "CORRECTION": return "Korekta"
        case "PRE_BOLUS": return "Bolus przed posiłkiem"
        default: return proposal.split != nil ? "Bolus dzielony" : "Bolus na posiłek"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "SUCCEEDED": return .green
        case "REJECTED", "PARTIAL", "SEND_FAILED", "EXPIRED": return .red
        case "NO_REPLY": return .orange
        default: return .secondary
        }
    }
}

/// Wysłano → Podano → Zapisano: a dot per step joined by lines, the current one spinning.
private struct BolusProgressBar: View {
    let steps: [BolusProgressStep]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                if index > 0 {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.3))
                        .frame(height: 1)
                        .frame(minWidth: 8, maxWidth: .infinity)
                }
                HStack(spacing: 5) {
                    dot(step.state)
                    Text(step.title)
                        .font(.footnote.weight(step.state == .active ? .semibold : .regular))
                        .foregroundStyle(step.state == .waiting ? Color.secondary : Color.primary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(steps.map { "\($0.title): \(spoken($0.state))" }.joined(separator: ", "))
    }

    @ViewBuilder
    private func dot(_ state: BolusProgressStep.State) -> some View {
        ZStack {
            Circle().fill(background(state))
            switch state {
            case .active:
                ProgressView().controlSize(.mini)
            case .done:
                Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.green)
            case .failed:
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.red)
            case .unknown:
                Image(systemName: "questionmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.orange)
            case .waiting:
                EmptyView()
            }
        }
        .frame(width: 20, height: 20)
    }

    private func background(_ state: BolusProgressStep.State) -> Color {
        switch state {
        case .done: return .green.opacity(0.18)
        case .failed: return .red.opacity(0.16)
        case .unknown: return .orange.opacity(0.18)
        case .active, .waiting: return .secondary.opacity(0.16)
        }
    }

    private func spoken(_ state: BolusProgressStep.State) -> String {
        switch state {
        case .done: return "gotowe"
        case .failed: return "nieudane"
        case .unknown: return "brak potwierdzenia"
        case .active: return "w toku"
        case .waiting: return "czeka"
        }
    }
}

/// A screen shown as a sheet (the WBT window) presents the confirmation over itself: the app gives it a flow of its own
/// and the confirmation's host; nil where remote commands are off.
public struct RemoteBolusHost {
    public let give: (RemoteBolusDraftBase) -> Void
    public let attach: (AnyView) -> AnyView

    public init(give: @escaping (RemoteBolusDraftBase) -> Void, attach: @escaping (AnyView) -> AnyView) {
        self.give = give
        self.attach = attach
    }
}

private struct RemoteBolusHostKey: EnvironmentKey {
    static let defaultValue: RemoteBolusHost? = nil
}

public extension EnvironmentValues {
    var remoteBolusHost: RemoteBolusHost? {
        get { self[RemoteBolusHostKey.self] }
        set { self[RemoteBolusHostKey.self] = newValue }
    }
}

/// "prognoza / min. ok. 82" in the header of a card or an option: grey from 70, orange below 70, red below 54. Always a
/// forecast, never a promise.
struct ForecastLabel: View {
    let minimum: Int

    static func color(_ minimum: Int) -> Color {
        minimum < 54 ? .red : minimum < 70 ? .orange : .secondary
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Text("prognoza")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("min. ok. \(minimum)")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(Self.color(minimum))
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Prognoza: najniżej około \(minimum) mg/dL")
    }
}

// MARK: - Plan chart (card-forecast.v1)

/// The glucose with a card's whole plan (card-forecast.v1): the line without the card, the line with every step of the
/// plan, and the steps as markers on the time axis. Server-computed when the card was made, so it is "as of" the card.
public struct CardForecastChart: Codable, Equatable, Sendable {
    public struct Event: Codable, Equatable, Sendable {
        public let at_minutes: Int
        /// NOW, LATER or WBT.
        public let kind: String
        public let carbs_g: Double
        public let insulin_u: Double
        /// A later part waiting for glucose (stopped falling, rising, above): drawn at its earliest time.
        public let conditional: Bool
    }

    public let start: String
    public let step_minutes: Int
    public let baseline: [Int]
    public let with_plan: [Int]?
    public let band: [Int]
    public let events: [Event]

    public init(start: String, step_minutes: Int, baseline: [Int], with_plan: [Int]?, band: [Int], events: [Event]) {
        self.start = start
        self.step_minutes = step_minutes
        self.baseline = baseline
        self.with_plan = with_plan
        self.band = band
        self.events = events
    }

    public var startDate: Date? { ServerDate.parse(start) }

    /// One point per step from the start; band from `band` where it has a value.
    func points(_ values: [Int]) -> [(date: Date, value: Double, band: Double)] {
        guard let startDate else { return [] }
        return values.enumerated().map { index, value in
            (startDate.addingTimeInterval(Double(index * step_minutes) * 60), Double(value), Double(band.indices.contains(index) ? band[index] : 0))
        }
    }

    /// "1,9 j · 6 g", "Wpis 7 g", "WBT ok. 0,55 j": a marker's label.
    static func label(_ event: Event) -> String {
        let units = event.insulin_u > 0 ? "\(RemoteCommandFormat.units(event.insulin_u)) j" : nil
        let carbs = event.carbs_g > 0 ? "\(Int(event.carbs_g.rounded())) g" : nil
        if event.kind == "WBT" { return units.map { "WBT ok. \($0)" } ?? "WBT" }
        if let units, let carbs { return "\(event.kind == "LATER" ? "ok. " : "")\(units) · \(carbs)" }
        if let units { return event.kind == "LATER" ? "ok. \(units)" : units }
        return carbs.map { "Wpis \($0)" } ?? ""
    }
}

struct CardForecastChartView: View {
    let chart: CardForecastChart

    var body: some View {
        let baseline = chart.points(chart.baseline)
        let withPlan = chart.with_plan.map { chart.points($0) } ?? []
        let banded = withPlan.isEmpty ? baseline : withPlan
        let start = chart.startDate ?? Date()
        let end = baseline.last?.date ?? start.addingTimeInterval(3 * 3600)
        let values = baseline.map(\.value) + withPlan.map(\.value)
        let minValue = min(40, (values.min() ?? 40) - 10)
        let maxValue = max(250, (values.max() ?? 250) + 15)

        VStack(alignment: .leading, spacing: 8) {
            Chart {
                RectangleMark(xStart: .value("Od", start), xEnd: .value("Do", end), yStart: .value("Dół", 70), yEnd: .value("Góra", 180))
                    .foregroundStyle(Color.green.opacity(0.1))
                RuleMark(y: .value("Próg", 70))
                    .foregroundStyle(Color.red.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                ForEach(banded, id: \.date) { point in
                    AreaMark(x: .value("Czas", point.date), yStart: .value("Od", max(minValue, point.value - point.band)), yEnd: .value("Do", min(maxValue, point.value + point.band)), series: .value("Seria", "Pasmo"))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Color.accentColor.opacity(0.12))
                }
                ForEach(baseline, id: \.date) { point in
                    LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Bez karty"))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Color.secondary)
                        .lineStyle(StrokeStyle(lineWidth: 1.4, dash: [4, 3]))
                }
                ForEach(withPlan, id: \.date) { point in
                    LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Z planem"))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Color.accentColor)
                        .lineStyle(StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                }
                ForEach(Array(chart.events.enumerated()), id: \.offset) { _, event in
                    let at = start.addingTimeInterval(Double(event.at_minutes) * 60)
                    RuleMark(x: .value("Krok", at))
                        .foregroundStyle(Self.color(event).opacity(0.75))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: event.conditional || event.kind == "WBT" ? [2, 3] : []))
                        // Only the icon: the doses are on the time line above, labels next to each other overlapped.
                        .annotation(position: .top, alignment: .center, spacing: 2) {
                            Image(systemName: Self.symbol(event))
                                .font(.caption2)
                                .foregroundStyle(Self.color(event))
                        }
                }
            }
            .chartXScale(domain: start...end)
            .chartYScale(domain: minValue...maxValue)
            .chartXAxis {
                AxisMarks(values: .stride(by: .hour)) { value in
                    AxisGridLine().foregroundStyle(Color.secondary.opacity(0.15))
                    AxisValueLabel {
                        if let date = value.as(Date.self) { Text(LoopFormat.clock(date)) }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: [70, 180, 250]) { _ in
                    AxisGridLine().foregroundStyle(Color.secondary.opacity(0.15))
                    AxisValueLabel()
                }
            }
            .frame(height: 190)
            .padding(.top, 18)
            .accessibilityLabel("Prognoza glukozy z planem karty")

            HStack(spacing: 12) {
                legend(color: .accentColor, dashed: false, text: "z planem")
                legend(color: .secondary, dashed: true, text: "bez karty")
            }
            // The steps with their times and doses (the chart shows only their icons).
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(chart.events.enumerated()), id: \.offset) { _, event in
                    HStack(spacing: 6) {
                        Image(systemName: Self.symbol(event))
                            .font(.caption2)
                            .foregroundStyle(Self.color(event))
                            .frame(width: 14)
                        Text(stepLine(event))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Text(footnote)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What the picture assumes: the loop does nothing more, a condition at its earliest time, WBT not in the line.
    private var footnote: String {
        var parts = ["Prognoza, nie pewność: zakłada, że pętla nic więcej nie zrobi."]
        if chart.events.contains(where: \.conditional) { parts.append("Część zależna od glukozy narysowana tam, gdzie prognoza spełnia jej warunek.") }
        if chart.events.contains(where: { $0.kind == "WBT" }) { parts.append("WBT tylko jako znacznik (późny wzrost po tłuszczu i białku nie jest w linii).") }
        return parts.joined(separator: " ")
    }

    /// "11:20 · ok. 2 j (gdy przestanie spadać)".
    private func stepLine(_ event: CardForecastChart.Event) -> String {
        let at = (chart.startDate ?? Date()).addingTimeInterval(Double(event.at_minutes) * 60)
        return "\(LoopFormat.clock(at)) · \(CardForecastChart.label(event))\(event.conditional ? " (wg prognozy)" : "")"
    }

    private func legend(color: Color, dashed: Bool, text: String) -> some View {
        HStack(spacing: 4) {
            Capsule()
                .stroke(color, style: StrokeStyle(lineWidth: 2, dash: dashed ? [3, 2] : []))
                .frame(width: 16, height: 2)
            Text(text).font(.caption2).foregroundStyle(.secondary)
        }
    }

    static func symbol(_ event: CardForecastChart.Event) -> String {
        if event.kind == "WBT" { return "bell" }
        if event.insulin_u > 0 { return "syringe" }
        return "square.and.pencil"
    }

    static func color(_ event: CardForecastChart.Event) -> Color {
        event.kind == "WBT" ? .purple : event.insulin_u > 0 ? .accentColor : .orange
    }
}
