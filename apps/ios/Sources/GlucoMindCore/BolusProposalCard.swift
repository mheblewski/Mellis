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
        /// WITH_DOSE (the line with the card), LOOP_WITHOUT_DOSE (the loop's own forecast, without the card) or
        /// DOSE_TOTAL (the loop's forecast at its end plus the card's full effect); absent from older servers.
        public var basis: String? = nil
        /// The loop the forecast is from ("Trio", "Loop"); absent for the CGM trend.
        public var loop_name: String? = nil

        public var isRisky: Bool { level == "LOW" || level == "VERY_LOW" }

        /// Review 2026-11-10: plain words, no "mg/dL", time in hours ("za ok. 1 h 40 min").
        public var headline: String {
            let loop = loop_name ?? "Trend CGM"
            let when = min_in_minutes > 0 ? " za ok. \(Self.minutesInWords(min_in_minutes))" : ""
            switch basis {
            case "DOSE_TOTAL": return "\(loop) + pełne działanie karty: ok. \(min_mgdl)"
            case "LOOP_WITHOUT_DOSE": return "Bez jedzenia \(loop) przewiduje spadek do ok. \(min_mgdl)\(when)"
            default: return "Z tą kartą prognoza spada do ok. \(min_mgdl)\(when)"
            }
        }

        /// Red only below 54 within the hour (or insulin alone), orange for a later low, grey for the loop's own forecast
        /// without food on a card with carbs (the card is not its cause).
        public func tone(cardCarbsG: Int) -> RiskTone {
            if min_mgdl < Self.veryLowMgdl && (cardCarbsG == 0 || min_in_minutes <= Self.redWithinMinutes) { return .danger }
            if basis == "LOOP_WITHOUT_DOSE" && cardCarbsG > 0 { return .plain }
            return min_mgdl < Self.lowMgdl ? .warning : .plain
        }

        /// The server's CARD_ADVICE_POLICY (card-advice.ts): the same thresholds on both sides.
        static let lowMgdl = 70
        static let veryLowMgdl = 54
        static let redWithinMinutes = 60

        public enum RiskTone { case danger, warning, plain }

        static func minutesInWords(_ minutes: Int) -> String {
            if minutes < 60 { return "\(minutes) min" }
            let rest = minutes % 60
            return rest == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(rest) min"
        }
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
    /// Where a MEAL card's dose comes from (dose-calculator.v1): the line under the dose; absent on older cards.
    public var dose_calculation: CardDoseCalculation? = nil

    public struct CardDoseCalculation: Codable, Equatable {
        public let summary: String
        public let default_u: Double
        public let icr_dose_u: Double?
        public let calculator_u: Double?
        public let limited_by: String
        /// The line in a few words and the formula (behind the info button); absent on older servers.
        public var short_summary: String? = nil
        public var formula: String? = nil
        /// ACTIVE_INSULIN, FALLING, BELOW_TARGET, LOW_CARBS_FIRST, LOOP_FORECAST_LOW: why it is lowered; nil: not lowered.
        public var reason_code: String? = nil

        public var lowersDose: Bool { limited_by != "ICR" }
        public var line: String { short_summary.flatMap { $0.isEmpty ? nil : $0 } ?? summary }
        public var details: String? {
            let parts = [summary, formula.map { "Wzór: \($0)" }].compactMap { $0 }.filter { !$0.isEmpty }
            let text = parts.joined(separator: "\n\n")
            return text.isEmpty || text == line ? nil : text
        }
    }
    /// The forecast low of this card (absent: no fresh reading, or an older server).
    public var risk: Risk? = nil
    /// The glucose with the card's whole plan, behind the chart button (card-forecast.v1; absent on older cards).
    public var forecast_chart: CardForecastChart? = nil
    /// The correction the caregiver asked for on this card (absent: none).
    public var correction: Correction? = nil
    /// Every later part this card planned once its meal was saved (absent: none or an older server).
    public var planned_parts: [PlannedBolusSummary]? = nil
    /// rest-later.v1: less than carbs / ICR now (or 0 j): the rest's reminder, its time chosen by hand (absent: none).
    public var rest_offer: RestOffer? = nil

    public struct RestOffer: Codable, Equatable {
        public struct Current: Codable, Equatable {
            public let trigger: String
            public let minutes: Int?
        }
        public let rest_u: Double
        public let rest_carbs_g: Int
        public let falling: Bool
        public let current: Current?
    }

    /// What "Reszta później" can be: a time, "gdy przestanie spadać", or no reminder.
    public enum RestChoice: Equatable, Hashable, Encodable {
        case after(minutes: Int)
        case whenStoppedFalling

        private enum CodingKeys: String, CodingKey { case trigger, minutes }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .after(minutes):
                try container.encode("AFTER_MINUTES", forKey: .trigger)
                try container.encode(minutes, forKey: .minutes)
            case .whenStoppedFalling:
                try container.encode("GLUCOSE_STOPPED_FALLING", forKey: .trigger)
            }
        }

        /// "Za 30 min", "Za 1,5 h", "Gdy przestanie spadać".
        public var label: String {
            switch self {
            case .whenStoppedFalling: return "Gdy glukoza przestanie spadać"
            case let .after(minutes):
                if minutes < 60 { return "Za \(minutes) min" }
                return minutes % 60 == 0 ? "Za \(minutes / 60) h" : "Za \(LoopFormat.number(Double(minutes) / 60)) h"
            }
        }

        /// The button's own short words ("Po spadku", "Za 30 min").
        public var shortLabel: String { self == .whenStoppedFalling ? "Po spadku" : label }

        public static let presets: [Int] = [15, 30, 60, 90, 120]
    }

    /// The card's current reminder of the rest (nil: none).
    public var currentRestChoice: RestChoice? {
        guard let current = rest_offer?.current else { return nil }
        if current.trigger == "GLUCOSE_STOPPED_FALLING" { return .whenStoppedFalling }
        return current.minutes.map { .after(minutes: $0) }
    }
    /// The WBT reminder of the meal this card saved (absent: none).
    public var wbt_reminder: CardWbtReminder? = nil
    /// The meal's WBT and whether its reminder will be set on its own (absent: no protein or fat known).
    public var wbt_plan: WbtPlan? = nil
    /// The answer's option the card belongs to (A-C; absent without options and on older servers).
    public var option_key: String? = nil
    /// When the card was computed (absent on older servers).
    public var created_at: String? = nil
    /// What the loop expects without the card, when the card brings carbs only (card-advice.v2): a plain line, not a
    /// warning of the card (absent: nothing to say, or an older server).
    public var situation: Situation? = nil
    /// Other plans for the same meal, as buttons under "Podaj" (card-variants.v1; absent on older servers and own plans).
    public var variants: [Variant]? = nil
    /// The fast carbs the data advised when the card was made (a low now or soon; absent: none, or an older server).
    /// The planned meal's page shows them as the plan's first step; the chat shows its own rescue card instead.
    public var fast_carbs_first: FastCarbsFirst? = nil

    public struct FastCarbsFirst: Codable, Equatable {
        public let carbs_g: Double?
        /// BELOW_70, PREDICTED_LOW, …
        public let level: String
        public var glucose_mgdl: Double? = nil
        public var minutes_to_low: Int? = nil
    }

    public struct Situation: Codable, Equatable {
        /// "Bez tej karty Trio przewiduje spadek do ok. 65 mg/dL za ok. 40 min. Węglowodany z karty go łagodzą."
        public let text: String
        public let min_mgdl: Int
        public let min_in_minutes: Int
        public var loop_name: String? = nil
    }

    /// A plan to switch the card to: computed by the server like a card, the card is replaced when it is chosen.
    public struct Variant: Codable, Equatable, Identifiable {
        public struct Part: Codable, Equatable {
            public let trigger: String
            public let after_minutes: Int?
            public let carbs_g: Int
            public let insulin_u: Double?
        }

        public struct PlanRisk: Codable, Equatable {
            public let min_mgdl: Int
            public let level: String
            public let basis: String?
        }

        /// MORE_LATER, ALL_NOW, SPLIT, HALF_NOW, FULL_BOLUS_NOW or BOLUS_LATER
        public let kind: String
        /// The button: "Więcej później", "Całość teraz"…
        public let label: String
        public let carbs_now_g: Int
        public let insulin_now_u: Double
        public let later: [Part]
        public let risk: PlanRisk?
        /// The plan leads to a low or carries a strong warning: asked before the card is replaced (ack_text).
        public let needs_ack: Bool
        public let ack_text: String?

        public var id: String { kind }
    }

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
    public func retryBase(conversationID: String?) -> RemoteBolusDraftBase? {
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
    /// A planned meal's card's retry of a refused command (no conversation).
    public var mealPlanRetryBase: RemoteBolusDraftBase? { retryBase(conversationID: nil) }

    /// A planned meal's card (no conversation): given as the chat's card is, by its id.
    public var mealPlanDraftBase: RemoteBolusDraftBase {
        var base = RemoteBolusDraftBase(
            source: .chatCard,
            carbsG: carbs_g,
            insulinU: Decimal(string: String(format: "%.2f", insulin_u), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(insulin_u),
            conversationID: nil,
            proposalID: id,
            meal: carbs_g > 0 ? meal : nil,
            cardWarnings: warnings
        )
        base.proposalExpiresAt = expiresAt
        return base
    }

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
        command?.progressSteps(loop: loop, isWBT: purpose == "WBT") ?? []
    }
}

public extension ConversationBolusProposal.SentCommand {
    /// The pump's answer was garbled ("Bolus mógł się nie udać") and the check whether the loop's bolus reached Nightscout
    /// is still on: "Sprawdzam" instead of "Nie wiadomo". Counted from the confirmation (the card has no answer time):
    /// the answer comes about 5 s after it, so this ends about when the Bolus tab's 30 s check does.
    static let uncertainCheckSeconds: TimeInterval = 40

    func isCheckingUncertain(now: Date = Date()) -> Bool {
        guard status == "UNCERTAIN", let authorized = authorized_at.flatMap(ServerDate.parse) else { return false }
        return now.timeIntervalSince(authorized) < Self.uncertainCheckSeconds
    }

    /// The same steps wherever a dose is followed: the chat's card and the meal page.
    func progressSteps(loop: LoopSystemNames, isWBT: Bool = false, now: Date = Date()) -> [BolusProgressStep] {
        let sent: BolusProgressStep.State = switch status {
        case "AUTHORIZED": .active
        case "SEND_FAILED", "EXPIRED": .failed
        default: .done
        }
        let given: BolusProgressStep.State = switch status {
        case "SUCCEEDED": .done
        case "REJECTED", "PARTIAL": .failed
        // The pump's answer was garbled: checking Nightscout first, then maybe given (never offered again).
        case "UNCERTAIN": isCheckingUncertain(now: now) ? .active : .unknown
        case "NO_REPLY": .unknown
        case "SENT", "TRIO_ACCEPTED": .active
        default: .waiting
        }
        var steps = [
            BolusProgressStep(title: "Wysłano", state: sent),
            BolusProgressStep(title: insulin_u > 0 ? "Podano" : "W \(loop.locative)", state: given),
        ]
        if carbs_g > 0 || isWBT {
            let meal: BolusProgressStep.State
            if meal_record_id != nil || meal_state == "SAVED" {
                meal = .done
            } else if meal_state == "SAVING" {
                meal = .active
            } else if meal_state == "NOT_FOUND" {
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
    /// later-time.v1: a sent card's scheduled later part moved to minutes after its meal (nil: no "Zmień").
    var onMovePart: ((PlannedBolusSummary, Int) -> Void)? = nil
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
    /// A variant button (card-variants.v1): the card is replaced with that plan (nil: no buttons).
    var onChooseVariant: ((ConversationBolusProposal.Variant) -> Void)? = nil
    /// The chosen variant is being computed: the buttons wait.
    var variantBusy = false
    /// Why the last variant could not be chosen (nil: nothing to say).
    var variantError: String? = nil
    /// rest-later.v1: "Reszta później" chose a reminder (nil: none) and the card is computed again with it (nil: no row).
    var onChooseRest: ((ConversationBolusProposal.RestChoice?) -> Void)? = nil
    /// later-time.v1: "Zmień" at a later dose before sending: the card is computed again with it at minutes after the meal.
    var onChooseLaterTime: ((Int) -> Void)? = nil
    /// When the card's own part is for later (a planned meal before its time: "11:53"); nil: now.
    var firstPartAt: String? = nil
    /// "Pomiń" on the fast carbs step (the step hides on this phone; the place may remember it).
    var onSkipLeading: (() -> Void)? = nil

    @State private var showsDetails = false
    /// "Inny plan" unfolded: the other plans as buttons.
    @State private var showsOtherPlans = false
    /// Leading steps (fast carbs) the caregiver skipped on this phone.
    @State private var skippedLeading: Set<String> = []
    /// A variant that leads to a low, waiting for "Zmień plan mimo to".
    @State private var pendingVariant: ConversationBolusProposal.Variant?

    var body: some View {
        // Redrawn just after the card expires: [Podaj] turns into "Przelicz" without waiting for the next refresh. The
        // state is read from the clock, not from context.date: an explicit schedule hands its first entry's date (the
        // expiry) to the very first render too, which showed a fresh card as expired.
        TimelineView(.explicit(proposal.state == "PROPOSED" ? proposal.expiresAt.map { [$0.addingTimeInterval(1)] } ?? [] : [])) { _ in
            card(state: proposal.state(at: Date()))
        }
    }

    @ViewBuilder
    private func card(state: String) -> some View {
        if state == "SENT" {
            sentCard(state: state)
        } else {
            planCard(state: state)
        }
    }

    /// After the dose went: the whole plan on its time line with each part's switch, and the command's progress.
    private func sentCard(state: String) -> some View {
        let all = proposal.timelineSteps(loop: loop)
        let later = all.filter { $0.id != "now" }
        // The step to do next is drawn as the active one (owner 2026-11-10, the sent card as steps).
        let given = proposal.command?.status == "SUCCEEDED"
        // Never two active steps (owner 2026-11-10): while the first dose is on its way, refused or unknown, it is the
        // active one; the next later step becomes active only once the first was given.
        let nextID = given ? later.first { $0.state == .planned || $0.state == .due }?.id : nil
        return VStack(alignment: .leading, spacing: 14) {
            header(state: state)

            if let headline = sentHeadline(hasLater: !later.isEmpty), let command = proposal.command {
                let outcome = SentOutcome(command.status)
                HStack(alignment: .top, spacing: 10) {
                    if let symbol = outcome.symbol {
                        Image(systemName: symbol)
                            .foregroundStyle(outcome.color)
                            .accessibilityHidden(true)
                    }
                    Text(headline)
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            ForEach(leadingSteps) { step in doneRow(step) }

            if let command = proposal.command {
                // A bolus that just went stays open for a moment with its three green steps (mockup 4), then folds.
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    let justGiven = given && (command.authorized_at.flatMap(ServerDate.parse).map { context.date.timeIntervalSince($0) < 45 } ?? false)
                    if given {
                        // Done is a check and no frame (owner 2026-11-10: "za mało widać, który krok jest zakończony");
                        // the three green steps stay under it for a moment after the bolus went.
                        sentFirstDone(command, hasLater: !later.isEmpty, showsProgress: justGiven)
                    } else {
                        stepBox(index: 1, title: firstSentTitle(command, hasLater: !later.isEmpty), active: true, tint: SentOutcome(command.status).color) {
                            sentAmounts(command)
                            sent(command)
                        }
                    }
                }
            }

            ForEach(Array(later.enumerated()), id: \.element.id) { index, step in
                sentLaterStep(step, index: index + 2, active: step.id == nextID)
            }

            if let leadingAction {
                leadingAction
            }

            if given, let command = proposal.command, let mealID = command.meal_record_id, let onOpenMeal {
                Divider()
                Button {
                    onOpenMeal(mealID)
                } label: {
                    Label("Otwórz posiłek", systemImage: "fork.knife")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }

            if showsDetails {
                details
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, embedded ? 0 : 16)
        .padding(.vertical, embedded ? 0 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(embedded ? Color.clear : Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    /// "Pierwsza dawka podana o 18:43. Nie podawaj jej ponownie." / "Dawka idzie do Trio. Nie wysyłaj jej ponownie.";
    /// nil for a refused or failed command (its own line says what happened and offers the retry).
    private func sentHeadline(hasLater: Bool) -> String? {
        guard let command = proposal.command else { return nil }
        let at = command.authorized_at.flatMap(ServerDate.parse).map(LoopFormat.clock)
        let carbsOnly = command.insulin_u <= 0
        switch command.status {
        case "SUCCEEDED":
            if carbsOnly { return "Węglowodany wpisane\(at.map { " o \($0)" } ?? ""). Nie wpisuj ich ponownie." }
            return hasLater
                ? "Pierwsza dawka podana\(at.map { " o \($0)" } ?? ""). Nie podawaj jej ponownie."
                : "Bolus podany\(at.map { " o \($0)" } ?? ""). Nie podawaj go ponownie."
        case "AUTHORIZED", "SENT", "TRIO_ACCEPTED":
            return carbsOnly ? "Węglowodany idą do \(loop.genitive). Nie wysyłaj ich ponownie." : "Dawka idzie do \(loop.genitive). Nie wysyłaj jej ponownie."
        case "NO_REPLY":
            return "\(loop.nominative) nie \(loop.agree(m: "odpowiedział", f: "odpowiedziała", n: "odpowiedziało")). Bolus mógł zostać podany: nie wysyłaj go ponownie."
        case "UNCERTAIN":
            return command.isCheckingUncertain() ? "Pompa odpowiedziała niewyraźnie. Sprawdzam, czy bolus został podany." : "Nie wiadomo, czy bolus został podany. Nie wysyłaj go ponownie."
        case "PARTIAL":
            return "\(loop.nominative) \(loop.agree(m: "odrzucił", f: "odrzuciła", n: "odrzuciło")) bolus. Węglowodany są już zapisane."
        case "REJECTED", "SEND_FAILED", "EXPIRED":
            return "Nic nie zostało podane."
        default:
            return nil
        }
    }

    /// The sent command's outcome as the mockups colour it: green given, red refused or not sent, orange not known.
    private struct SentOutcome {
        let symbol: String?
        let color: Color
        init(_ status: String) {
            switch status {
            case "SUCCEEDED": symbol = "checkmark.circle"; color = Brand.inRange
            case "PARTIAL", "REJECTED", "SEND_FAILED", "EXPIRED": symbol = "exclamationmark.circle"; color = .red
            case "NO_REPLY", "UNCERTAIN": symbol = "exclamationmark.triangle"; color = .orange
            default: symbol = nil; color = Brand.interactive
            }
        }
    }

    private func firstSentTitle(_ command: ConversationBolusProposal.SentCommand, hasLater: Bool) -> String {
        let at = command.authorized_at.flatMap(ServerDate.parse).map(LoopFormat.clock)
        return ((hasLater ? "Pierwsza dawka" : "Dawka") + (at.map { " · \($0)" } ?? "")).uppercased()
    }

    /// "4 j i 20 g" and, when less went than the card said, "z 8 j i 40 g na karcie" (owner 2026-11-10: the waffles).
    @ViewBuilder
    private func sentAmounts(_ command: ConversationBolusProposal.SentCommand) -> some View {
        let sent = [command.insulin_u > 0 ? "\(RemoteCommandFormat.units(command.insulin_u)) j" : nil, command.carbs_g > 0 ? "\(command.carbs_g) g" : nil].compactMap { $0 }.joined(separator: " i ")
        Text(sent)
            .font(.headline.monospacedDigit())
        if let less = lessThanCard(command) {
            Text(less)
                .font(.caption)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The card said more than went: what the card had, so the missing part is never silently lost.
    private func lessThanCard(_ command: ConversationBolusProposal.SentCommand) -> String? {
        let lessInsulin = command.insulin_u + 0.001 < proposal.insulin_u
        let lessCarbs = command.carbs_g < proposal.carbs_g
        guard lessInsulin || lessCarbs else { return nil }
        let card = [proposal.insulin_u > 0 ? "\(RemoteCommandFormat.units(proposal.insulin_u)) j" : nil, proposal.carbs_g > 0 ? "\(proposal.carbs_g) g" : nil].compactMap { $0 }.joined(separator: " i ")
        return "Mniej niż na karcie (\(card)). Reszty tej części nikt nie przypomni."
    }

    /// The given first dose as one quiet line with its check, the extra notes the command still has.
    private func sentFirstDone(_ command: ConversationBolusProposal.SentCommand, hasLater: Bool, showsProgress: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(Color(uiColor: .systemBackground))
                .frame(width: 28, height: 28)
                .background(Circle().fill(Brand.inRange))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(firstSentTitle(command, hasLater: hasLater))
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(Brand.inRange)
                sentAmounts(command)
                if showsProgress {
                    BolusProgressBar(steps: command.progressSteps(loop: loop, isWBT: proposal.purpose == "WBT"))
                        .padding(.top, 4)
                }
                if !command.sent_by_me {
                    Text("Wysłane przez drugiego opiekuna").font(.caption).foregroundStyle(.secondary)
                }
                if command.meal_record_id == nil && command.meal_state == "NOT_FOUND" {
                    Label(proposal.purpose == "WBT" ? "WBT nie zapisało się automatycznie: sprawdź wpis w posiłku." : "Posiłek nie zapisał się automatycznie: sprawdź zakładkę Posiłki.", systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(0.85)
        }
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
    }

    /// A later part or the WBT reminder of a sent card: done (a check and one grey line), off (grey), or to come with
    /// "Nie podawaj teraz." and its switch; the next one is the active step.
    @ViewBuilder
    private func sentLaterStep(_ step: CardTimelineStep, index: Int, active: Bool) -> some View {
        let ordinals = ["Pierwsza", "Druga", "Trzecia", "Czwarta", "Piąta"]
        let name = step.isWbt ? "Na tłuszcz i białko (WBT)" : (index - 1 < ordinals.count ? "\(ordinals[index - 1]) dawka" : "Kolejna dawka")
        let title = "\(name) · \(step.time)".uppercased()
        switch step.state {
        case .done:
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Brand.inRange))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.caption.weight(.bold)).tracking(0.6).foregroundStyle(Brand.inRange)
                    Text([step.detail, step.note].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 12)
            .accessibilityElement(children: .combine)
        default:
            stepBox(index: index, title: title, active: active) {
                if step.state == .planned || step.state == .due {
                    Text(step.state == .due ? "Czas na tę dawkę: otwórz posiłek." : "Nie podawaj teraz.")
                        .font(.subheadline.weight(.semibold))
                }
                Text(step.detail)
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(.secondary)
                if let note = step.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(alignment: .center, spacing: 8) {
                    Spacer(minLength: 0)
                    if case .skipPart(let part) = step.action, part.status == "SCHEDULED", (part.trigger ?? "AFTER_MINUTES") == "AFTER_MINUTES", let onMovePart,
                       let due = ServerDate.parse(part.due_at) {
                        laterTimeMenu(start: due.addingTimeInterval(TimeInterval(-part.delay_minutes * 60)), current: part.delay_minutes) { minutes in onMovePart(part, minutes) }
                            .disabled(busySwitches.contains(part.id))
                    }
                    if let actionTitle = step.actionTitle, let action = step.action, let timelineAction {
                        Button(actionTitle) { timelineAction(action) }
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .fixedSize()
                            .buttonStyle(.bordered)
                            .disabled(busySwitches.contains(action.switchID))
                    }
                }
            }
            .opacity(step.state == .off ? 0.6 : 1)
        }
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
        let tone = risk.tone(cardCarbsG: proposal.carbs_g)
        let color: Color = tone == .danger ? .red : tone == .warning ? .orange : .secondary
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: tone == .danger ? "exclamationmark.octagon.fill" : tone == .warning ? "exclamationmark.triangle.fill" : "chart.line.downtrend.xyaxis")
            VStack(alignment: .leading, spacing: 1) {
                Text(risk.headline)
                    .font(.footnote.weight(.medium))
                Text(risk.basis == "LOOP_WITHOUT_DOSE" ? "prognoza testowa, bez dawki z karty" : "prognoza testowa, zakłada, że pętla nic więcej nie zrobi")
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
    private func sent(_ command: ConversationBolusProposal.SentCommand) -> some View {
        if command.status == "UNCERTAIN" {
            // "Sprawdzam" turns into "Nie wiadomo" by itself when the check ends (nothing on the server changes then).
            TimelineView(.periodic(from: .now, by: 5)) { context in
                sentBody(command, now: context.date)
            }
        } else {
            sentBody(command, now: Date())
        }
    }

    @ViewBuilder
    private func sentBody(_ command: ConversationBolusProposal.SentCommand, now: Date) -> some View {
        let checking = command.isCheckingUncertain(now: now)
        VStack(alignment: .leading, spacing: 8) {
            BolusProgressBar(steps: command.progressSteps(loop: loop, isWBT: proposal.purpose == "WBT", now: now))

            Text(checking ? "Pompa odpowiedziała niewyraźnie. Sprawdzam, czy bolus został podany…" : statusLine(command))
                .font(.footnote)
                .foregroundStyle(checking ? Color.secondary : statusColor(command.status))
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
        case "NO_REPLY", "UNCERTAIN": return .orange
        default: return .secondary
        }
    }
}

/// Wysłano → Podano → Zapisano: a dot per step joined by lines, the current one spinning.
struct BolusProgressBar: View {
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

private struct OpenBolusWithCarbsKey: EnvironmentKey {
    static let defaultValue: ((Int) -> Void)? = nil
}

public extension EnvironmentValues {
    /// The Bolus tab with these grams typed (the meal chat's "Policz teraz w Bolus", review 2026-11-10); nil when this
    /// caregiver cannot give remotely.
    var openBolusWithCarbs: ((Int) -> Void)? {
        get { self[OpenBolusWithCarbsKey.self] }
        set { self[OpenBolusWithCarbsKey.self] = newValue }
    }

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
    /// MODEL or LOOP_ONLY (bolus-forecast.v7: only the loop's own line, the plan as markers); absent: MODEL.
    public var dose_line: String? = nil
    /// The baseline's end plus the whole plan's full effect, mg/dL (LOOP_ONLY's check of the plan).
    public var total_with_plan: Int? = nil
    /// The loop whose forecast the baseline is ("Trio", "Loop"); absent for the CGM trend.
    public var loop_name: String? = nil

    public var isLoopOnly: Bool { dose_line == "LOOP_ONLY" }

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
                // Alone (LOOP_ONLY) the loop's line is the chart's line; next to a line with the plan, the dashed one without.
                ForEach(baseline, id: \.date) { point in
                    LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Bez karty"))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(chart.isLoopOnly ? Color.accentColor : Color.secondary)
                        .lineStyle(chart.isLoopOnly ? StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round) : StrokeStyle(lineWidth: 1.4, dash: [4, 3]))
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
            .accessibilityLabel(chart.isLoopOnly ? "\(loopForecast) bez tej karty, z krokami planu" : "Prognoza glukozy z planem karty")

            HStack(spacing: 12) {
                if chart.isLoopOnly {
                    legend(color: .accentColor, dashed: false, text: "\(loopForecast), bez tej karty")
                } else {
                    legend(color: .accentColor, dashed: false, text: "z planem")
                    legend(color: .secondary, dashed: true, text: "bez karty")
                }
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

    /// "Prognoza Trio", or the CGM trend's when the loop's forecast was not fresh.
    private var loopForecast: String {
        chart.loop_name.map { "prognoza \($0)" } ?? "trend CGM"
    }

    /// What the picture assumes: the loop does nothing more, a condition at its earliest time, WBT not in the line.
    private var footnote: String {
        if chart.isLoopOnly {
            var parts = ["Linia to \(loopForecast) bez tej karty: dawki z karty uwzględni dopiero po ich podaniu. Kroki planu są tylko znacznikami."]
            if let total = chart.total_with_plan { parts.append("Na koniec z pełnym działaniem planu: ok. \(total) (zakłada, że pętla nic więcej nie zrobi).") }
            if chart.events.contains(where: \.conditional) { parts.append("Część zależna od glukozy narysowana w najwcześniejszym czasie.") }
            return parts.joined(separator: " ")
        }
        var parts = ["Prognoza, nie pewność: zakłada, że pętla nic więcej nie zrobi."]
        if chart.events.contains(where: \.conditional) { parts.append("Część zależna od glukozy narysowana tam, gdzie prognoza spełnia jej warunek.") }
        if chart.events.contains(where: { $0.kind == "WBT" }) { parts.append("WBT tylko jako znacznik (późny wzrost po tłuszczu i białku nie jest w linii).") }
        return parts.joined(separator: " ")
    }

    /// "11:20 · ok. 2 j (gdy przestanie spadać)".
    private func stepLine(_ event: CardForecastChart.Event) -> String {
        let at = (chart.startDate ?? Date()).addingTimeInterval(Double(event.at_minutes) * 60)
        return "\(LoopFormat.clock(at)) · \(CardForecastChart.label(event))\(event.conditional ? (chart.isLoopOnly ? " (najwcześniej)" : " (wg prognozy)") : "")"
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

/// The user documentation (docs-site, MkDocs): the manual's base and the pages the app opens.
public enum MellisDocs {
    public static let manual = URL(string: "https://mheblewski.github.io/Mellis/")!
    /// "Jak Mellis proponuje dawki": the formula, lowering only, the warnings (docs-site/docs/codzienne/dawki.md).
    public static let doses = URL(string: "codzienne/dawki/", relativeTo: manual)!.absoluteURL
}

/// Where the dose comes from (dose-calculator.v1): how much and why it differs from carbs / ICR ("↓ 0,3 j mniej niż z
/// przelicznika (3,85 j): aktywna insulina"), else "Z przelicznika"; the breakdown and the formula sit behind the info button.
public struct DoseExplanationLine: View {
    let line: String
    let details: String?
    let lowersDose: Bool
    let font: Font
    let lineLimit: Int
    @State private var showsDetails = false

    public init(line: String, details: String?, lowersDose: Bool, font: Font = .footnote, lineLimit: Int = 3) {
        self.line = line
        self.details = details
        self.lowersDose = lowersDose
        self.font = font
        self.lineLimit = lineLimit
    }

    public var body: some View {
        HStack(alignment: .center, spacing: 2) {
            // Only how much and why the dose differs from carbs / ICR (owner 2026-10-29): orange when lowered, else a
            // grey "Z przelicznika"; IOB, glucose and the rest are in the popover, not repeated here.
            Text(line)
                .font(font)
                .foregroundStyle(lowersDose ? Color.orange : Color.secondary)
                .lineLimit(lineLimit)
                .minimumScaleFactor(0.85)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("bolus.calculatorLine")
            if details != nil {
                // A child tap gesture, not a Button: the Bolus tab's field tile has its own tap (focus the field),
                // which took the Button's tap and the popover never opened.
                Image(systemName: "info.circle")
                    .font(font)
                    .foregroundStyle(.secondary)
                    // A finger-sized target around the small icon.
                    .frame(minWidth: 30, minHeight: 30)
                    .contentShape(Rectangle())
                    .onTapGesture { showsDetails = true }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("Skąd ta dawka")
                    .accessibilityAction { showsDetails = true }
                    .accessibilityIdentifier("bolus.calculatorDetails")
            }
        }
        .popover(isPresented: $showsDetails, arrowEdge: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(details ?? "")
                        .font(.footnote)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    // The rules in plain words (the formula, lowering only, the warnings), in the browser.
                    Link(destination: MellisDocs.doses) {
                        Label("Jak liczona jest ta dawka?", systemImage: "book")
                            .font(.footnote.weight(.medium))
                    }
                    .accessibilityIdentifier("bolus.calculatorDocs")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .frame(idealWidth: 320, maxWidth: 360, maxHeight: 320)
            .presentationCompactAdaptation(.popover)
        }
    }
}

// MARK: - Card A (bolus card plan, 2026-11-08): one plan, the dose now big, the later parts as their own boxes.

/// A later part of the card's plan as the card shows it: when, and its dose and carbs.
struct CardLaterPart: Equatable, Identifiable {
    let id: Int
    /// "Jeszcze ok. 14:20" or "Gdy glukoza przestanie spadać"
    let title: String
    /// "14:20" or "po spadku": the split bar's label.
    let shortTime: String
    let insulinU: Double
    /// The dose is computed when the reminder comes ("ok."), or fixed as the caregiver named it.
    let insulinEstimated: Bool
    let carbsG: Int
}

extension ConversationBolusProposal {
    /// The later parts of the plan, in order (none: one bolus now).
    func laterParts(now: Date = Date()) -> [CardLaterPart] {
        guard let split else { return [] }
        let start = created_at.flatMap(ServerDate.parse) ?? now
        return ([split] + (split.more_parts ?? [])).enumerated().map { index, part in
            let condition = LaterTriggerText.condition(trigger: part.laterTrigger, thresholdMgdl: part.threshold_mgdl)
            let at = LoopFormat.clock(start.addingTimeInterval(TimeInterval(part.later_after_minutes * 60)))
            return CardLaterPart(
                id: index,
                // Review 2026-11-10: a glucose condition always says its time limit ("…, najpóźniej o 16:20").
                title: condition.map { text in
                    let capitalized = text.prefix(1).uppercased() + text.dropFirst()
                    guard let wait = part.wait_minutes, wait > 0 else { return capitalized }
                    let limit = LoopFormat.clock(start.addingTimeInterval(TimeInterval((part.later_after_minutes + wait) * 60)))
                    return "\(capitalized), najpóźniej o \(limit)"
                } ?? "Jeszcze ok. \(at)",
                shortTime: condition == nil ? at : LaterTriggerText.short(trigger: part.laterTrigger, afterMinutes: part.later_after_minutes, thresholdMgdl: part.threshold_mgdl),
                insulinU: part.fixed_insulin_u ?? part.later_insulin_u,
                insulinEstimated: part.fixed_insulin_u == nil,
                carbsG: part.later_carbs_g
            )
        }
    }
}

extension BolusProposalCard {
    /// Insulin as on the Teraz tiles (lighter in dark mode), carbs as the COB tile.
    static let insulinColor = Brand.dynamic(light: 0x0A6CFF, dark: 0x409CFF)
    static let carbsColor = Color.orange

    /// Before the dose goes (owner 2026-11-10, the three-step card): the reason in one sentence, then numbered steps, one
    /// number and one button each (fast carbs, the dose now or when eating starts, each later part with its time), the
    /// other plans behind "Inny plan" and the forecast and formula behind "Szczegóły". Expired: what happened and
    /// "Przelicz", never the old steps greyed out. The chat's card and the planned meal's are this one view.
    func planCard(state: String) -> some View {
        Group {
            if state == "EXPIRED" {
                expiredCard
            } else {
                stepsCard
            }
        }
        .padding(.horizontal, embedded ? 0 : 16)
        .padding(.vertical, embedded ? 0 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(embedded ? Color.clear : Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .sheet(item: $pendingVariant) { variant in
            VariantRiskSheet(variant: variant, loop: loop) { choose in
                pendingVariant = nil
                if choose { onChooseVariant?(variant) }
            }
            .presentationDetents([.medium])
        }
    }

    private var stepsCard: some View {
        let parts = proposal.laterParts()
        let leading = leadingSteps.filter { !skippedLeading.contains($0.id) }
        let leadingOpen = leading.contains { $0.state != .done && $0.state != .off }
        return VStack(alignment: .leading, spacing: 14) {
            if !embedded, let name = proposal.meal_description.flatMap({ $0.isEmpty ? nil : $0 }) ?? Optional(title) {
                Text(name)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let reason = reasonLine {
                Text(reason)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Role test 2026-11-10 (P0): this plan's own low stays on top, never only behind "Szczegóły".
            if let risk = proposal.risk, risk.isRisky, risk.tone(cardCarbsG: proposal.carbs_g) != .plain {
                riskBox(risk)
            }

            ForEach(Array(leading.enumerated()), id: \.element.id) { index, step in
                if step.state == .done {
                    doneRow(step)
                } else {
                    stepBox(index: index + 1, title: "TERAZ", active: true) {
                        Text(step.detail)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(Self.carbsColor)
                        if let note = step.note, !note.isEmpty {
                            Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        if index == leading.count - 1, let leadingAction {
                            leadingAction
                        }
                        Button("Pomiń") {
                            withAnimation(.easeInOut(duration: 0.2)) { _ = skippedLeading.insert(step.id) }
                            onSkipLeading?()
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .foregroundStyle(.secondary)
                    }
                }
            }

            stepBox(index: leading.count + 1, title: mainStepTitle(afterLeading: !leading.isEmpty), active: !leadingOpen) {
                bigNumbers
                // Insulin while the plan asks for fast carbs first is never the filled button (role test P0).
                giveButton(prominent: !leadingOpen && !insulinWaitsForCarbs)
                // Owner 2026-11-10: the outlined insulin button says why in four words.
                if onGive != nil, insulinWaitsForCarbs {
                    Text("Insulina dopiero po węglach.")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(Array(parts.enumerated()), id: \.element.id) { index, part in
                laterStep(part, index: leading.count + 2 + index, of: parts.count)
            }
            restStep(index: leading.count + 2)

            ForEach(urgentWarnings, id: \.self) { warning in
                Label(warning.message, systemImage: "exclamationmark.octagon.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            HStack {
                if onChooseVariant != nil, !(proposal.variants ?? []).isEmpty {
                    disclosureButton(showsOtherPlans ? "Inny plan ▴" : "Inny plan ▾") { showsOtherPlans.toggle() }
                }
                Spacer(minLength: 8)
                disclosureButton(showsDetails ? "Ukryj szczegóły" : "Szczegóły ›") { showsDetails.toggle() }
            }
            if showsOtherPlans {
                variantButtons
                    .transition(.opacity)
            } else if variantBusy {
                Text("Przeliczam plan…").font(.caption).foregroundStyle(.secondary)
            } else if let variantError {
                Text(variantError).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if showsDetails {
                VStack(alignment: .leading, spacing: 10) {
                    forecastLine
                    planDetails
                }
                .transition(.opacity)
            }
        }
    }

    /// The step's own title: "TERAZ", or when the planned meal is still ahead "NA POCZĄTEK POSIŁKU · O 14:39".
    private func mainStepTitle(afterLeading: Bool) -> String {
        if let firstPartAt { return "NA POCZĄTEK POSIŁKU · O \(firstPartAt)" }
        return afterLeading ? "POTEM, DO POSIŁKU" : "TERAZ"
    }

    /// One sentence above the steps: why the plan is what it is (falling glucose, a lower dose), or nothing to say.
    /// The plan asks for fast carbs before any insulin it has (role test P0: never the filled button).
    private var insulinWaitsForCarbs: Bool { proposal.fast_carbs_first != nil && proposal.insulin_u > 0 }

    /// Owner 2026-11-10 ("nie zrozumiałem, o co chodzi z tym drugim bolusem"): a later dose says which dose it is,
    /// "Druga dawka · ok. 18:59", whenever insulin also goes now; alone it keeps its time or condition.
    private func laterStepTitle(_ part: CardLaterPart) -> String {
        guard proposal.insulin_u > 0, part.insulinU > 0 else { return part.title }
        let ordinals = ["Druga", "Trzecia", "Czwarta", "Piąta"]
        let name = part.id < ordinals.count ? "\(ordinals[part.id]) dawka" : "Kolejna dawka"
        let when = part.title.hasPrefix("Jeszcze ok. ") ? "ok. " + part.title.dropFirst("Jeszcze ok. ".count) : part.title.prefix(1).lowercased() + part.title.dropFirst()
        return "\(name) · \(when)"
    }

    /// "Bolus w dwóch dawkach: pierwsza teraz, druga później." above the steps of a divided dose (owner 2026-11-10).
    private var splitLine: String? {
        let later = proposal.laterParts().filter { $0.insulinU > 0 }
        guard proposal.insulin_u > 0, !later.isEmpty else { return nil }
        switch later.count {
        case 1: return "Bolus w dwóch dawkach: pierwsza teraz, druga później."
        case 2: return "Bolus w trzech dawkach: pierwsza teraz, kolejne później."
        default: return "Bolus w kilku dawkach: pierwsza teraz, kolejne później."
        }
    }

    private var reasonLine: String? {
        if let fast = proposal.fast_carbs_first, proposal.state == "PROPOSED" {
            let glucose = fast.glucose_mgdl.map { "Glukoza \(Int($0.rounded()))" } ?? "Glukoza"
            let falling = fast.level == "PREDICTED_LOW" ? " i spada" : ""
            return proposal.insulin_u > 0 ? "\(glucose)\(falling), dlatego najpierw szybkie węgle." : "\(glucose)\(falling), dlatego insulina później."
        }
        if proposal.insulin_u <= 0, proposal.carbs_g > 0, proposal.split?.isDeferred == true {
            return "Najpierw węglowodany, insulina później, gdy glukoza przestanie spadać."
        }
        let lowered = proposal.dose_calculation.flatMap { $0.lowersDose ? $0.line : nil }
        let lines = [splitLine, lowered].compactMap { $0 }
        return lines.isEmpty ? nil : lines.joined(separator: " ")
    }

    private func stepBox<Content: View>(index: Int, title: String, active: Bool, tint: Color? = nil, @ViewBuilder content: () -> Content) -> some View {
        let color = tint ?? Brand.interactive
        return HStack(alignment: .top, spacing: 12) {
            Text("\(index)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(active ? Color(uiColor: .systemBackground) : .secondary)
                .frame(width: 28, height: 28)
                .background(Circle().fill(active ? color : Color.clear))
                .overlay(Circle().strokeBorder(active ? Color.clear : Color.secondary.opacity(0.6), lineWidth: 1.5))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(active ? color : .secondary)
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(active ? 12 : 0)
        .padding(.horizontal, active ? 0 : 12)
        .background(active ? color.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(active ? color.opacity(0.7) : Color.clear, lineWidth: 1.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Krok \(index): \(title.lowercased())")
    }

    private func doneRow(_ step: CardTimelineStep) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(Brand.inRange)
            Text([step.detail, step.note].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
    }

    /// A later part as a step: its time or condition, its own numbers, and "Zmień" for the rest's reminder.
    private func laterStep(_ part: CardLaterPart, index: Int, of count: Int) -> some View {
        stepBox(index: index, title: laterStepTitle(part).uppercased(), active: false) {
            // Role test P0: a later dose never reads as one to give now (a parent in a hurry types the big number).
            Text("Nie podawaj teraz.")
                .font(.subheadline.weight(.semibold))
            Text([
                part.insulinU > 0 ? "\(part.insulinEstimated ? "ok. " : "")\(RemoteCommandFormat.units(part.insulinU)) j" : nil,
                part.carbsG > 0 ? "\(part.carbsG) g" : nil,
            ].compactMap { $0 }.joined(separator: " i ") + " później")
                .font(.headline.monospacedDigit())
                .foregroundStyle(.secondary)
            HStack(alignment: .center, spacing: 8) {
                Text(part.insulinEstimated ? "Przypomnę obu opiekunom, dawkę policzę wtedy na nowo." : "Przypomnę obu opiekunom.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if count == 1, proposal.rest_offer != nil, onChooseRest != nil {
                    restMenu(label: "Zmień")
                } else if part.id == 0, part.title.hasPrefix("Jeszcze ok. "), let onChooseLaterTime {
                    // Only a dose at a time moves: one waiting for glucose to stop falling waits for a reason.
                    laterTimeMenu(start: proposal.created_at.flatMap(ServerDate.parse) ?? Date(), current: proposal.split?.later_after_minutes, onPick: onChooseLaterTime)
                }
            }
        }
    }

    /// rest-later.v1 without a later part yet: the rest as a step of its own, "Przypomnij" chooses when.
    @ViewBuilder
    private func restStep(index: Int) -> some View {
        if let offer = proposal.rest_offer, onChooseRest != nil, proposal.split == nil {
            stepBox(index: index, title: "RESZTA", active: false) {
                smallValue("ok. \(RemoteCommandFormat.units(offer.rest_u))", unit: "j", color: Self.insulinColor)
                HStack(alignment: .center, spacing: 8) {
                    Text("Bez przypomnienia")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    restMenu(label: "Przypomnij")
                }
            }
        }
    }

    private func disclosureButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { action() }
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Owner 2026-11-10: an expired card says what happened and offers one button, instead of its old steps greyed out.
    private var expiredCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "clock")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Ta dawka jest nieaktualna")
                        .font(.headline)
                    Text(ServerDate.parse(proposal.created_at ?? "").map { "Policzona o \(LoopFormat.clock($0)). Od tego czasu mogła się zmienić glukoza i insulina w organizmie." } ?? "Od jej policzenia mogła się zmienić glukoza i insulina w organizmie.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let onRecalculate {
                Button(action: onRecalculate) {
                    Text("Przelicz na aktualnych danych")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 16))
                .controlSize(.large)
            }
            Text("Nic nie zostało wysłane.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// The dose now as large numbers: insulin and carbs in the Teraz tiles' colours.
    private var bigNumbers: some View {
        HStack(alignment: .firstTextBaseline, spacing: 18) {
            if proposal.insulin_u > 0 {
                bigValue(RemoteCommandFormat.units(proposal.insulin_u), unit: "j", color: Self.insulinColor)
            }
            if proposal.carbs_g > 0 {
                bigValue("\(proposal.carbs_g)", unit: "g", color: Self.carbsColor)
            }
            if proposal.insulin_u <= 0 {
                Text("bez insuliny")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bigNumbersLabel)
    }

    private var bigNumbersLabel: String {
        let insulin = proposal.insulin_u > 0 ? "\(RemoteCommandFormat.units(proposal.insulin_u)) jednostki" : "bez insuliny"
        return proposal.carbs_g > 0 ? "Teraz \(insulin) i \(proposal.carbs_g) gramów węglowodanów" : "Teraz \(insulin)"
    }

    private func bigValue(_ value: String, unit: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value)
                .font(.system(size: 48, weight: .light, design: .rounded).monospacedDigit())
                .foregroundStyle(color)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text(unit)
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    private func smallValue(_ value: String, unit: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text(value)
                .font(.title2.monospacedDigit())
                .foregroundStyle(color)
            Text(unit)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    /// One line about the forecast: green when the plan stays above 70, grey for what the loop expects without the
    /// card, amber (red below 54 from the card itself) only for this plan's own low.
    @ViewBuilder
    private var forecastLine: some View {
        if let situation = proposal.situation {
            dotLine(situation.text, color: .secondary)
        } else if let risk = proposal.risk {
            if risk.isRisky {
                let tone = risk.tone(cardCarbsG: proposal.carbs_g)
                dotLine(risk.headline, color: tone == .danger ? .red : tone == .warning ? .orange : .secondary)
            } else {
                dotLine("Prognoza z tym planem: bez spadku poniżej 70", color: Brand.inRange)
            }
        }
    }

    private func dotLine(_ text: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text)
                .font(.footnote)
                .foregroundStyle(color == .secondary ? Color.secondary : Color.primary.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "Podaj część 1: 2,1 j i 32 g", "Podaj 3 j i 45 g", "Wpisz 40 g do Trio": exactly what goes now.
    private var planGiveTitle: String {
        let units = RemoteCommandFormat.units(proposal.insulin_u)
        // Before the planned time: the meal is already being eaten (owner 2026-11-10: "Posiłek trwa"; neutral, the app may be used by the patient).
        if firstPartAt != nil {
            if proposal.insulin_u <= 0 { return "Posiłek trwa, wpisz \(proposal.carbs_g) g" }
            return "Posiłek trwa, podaj \(proposal.carbs_g > 0 ? "\(units) j i \(proposal.carbs_g) g" : "\(units) j")"
        }
        if proposal.insulin_u <= 0 { return "Wpisz \(proposal.carbs_g) g do \(loop.genitive)" }
        let what = proposal.carbs_g > 0 ? "\(units) j i \(proposal.carbs_g) g" : "\(units) j"
        return "Podaj \(what)"
    }

    /// The step's button: filled while it is the step to do now, outlined while an earlier step waits.
    @ViewBuilder
    private func giveButton(prominent: Bool) -> some View {
        if let onGive {
            let button = Button(action: onGive) {
                // No Face ID mark: this opens the confirmation, where Face ID comes.
                Text(planGiveTitle)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
                    .frame(height: 34)
            }
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .controlSize(.large)
            .disabled(variantBusy)
            if prominent {
                button.buttonStyle(.borderedProminent)
            } else {
                button.buttonStyle(.bordered)
            }
        }
    }

    /// later-time.v1 (owner 2026-11-10: "skąd to 90 min?"): when the later dose comes, as minutes after the meal with
    /// the clock time ("1,5 h po posiłku · 20:13"). Times only: a glucose condition could lapse and lose the dose.
    /// Up to 2 h after the meal: from 2,5 h it is the WBT reminder's time (owner 2026-11-10).
    static let laterTimePresets = [30, 60, 90, 120]

    private func laterTimeMenu(start: Date, current: Int?, onPick: @escaping (Int) -> Void) -> some View {
        Menu {
            ForEach(Self.laterTimePresets, id: \.self) { minutes in
                let clock = LoopFormat.clock(start.addingTimeInterval(TimeInterval(minutes * 60)))
                let hours = minutes % 60 == 0 ? "\(minutes / 60) h" : minutes > 60 ? "\(minutes / 60),5 h" : "\(minutes) min"
                Button {
                    onPick(minutes)
                } label: {
                    Text("\(hours) po posiłku · \(clock)\(minutes == current ? " ✓" : "")")
                }
            }
        } label: {
            Label("Zmień", systemImage: "clock")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .fixedSize()
        }
        .buttonStyle(.bordered)
        .disabled(variantBusy)
        .accessibilityLabel("Zmień godzinę kolejnej dawki")
    }

    /// When the rest is reminded: "Po spadku" while glucose falls, a time, or no reminder; the card is computed again.
    private func restMenu(label: String) -> some View {
        let current = proposal.currentRestChoice
        let falling = proposal.rest_offer?.falling == true
        return Menu {
            if falling || current == .whenStoppedFalling {
                Button(ConversationBolusProposal.RestChoice.whenStoppedFalling.label) { onChooseRest?(.whenStoppedFalling) }
            }
            ForEach(ConversationBolusProposal.RestChoice.presets, id: \.self) { minutes in
                Button(ConversationBolusProposal.RestChoice.after(minutes: minutes).label) { onChooseRest?(.after(minutes: minutes)) }
            }
            if current != nil {
                Button("Bez przypomnienia", role: .destructive) { onChooseRest?(nil) }
            }
        } label: {
            Label(label, systemImage: "bell")
                .font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.bordered)
        .disabled(variantBusy)
        .accessibilityLabel(label == "Zmień" ? "Zmień czas przypomnienia" : "Przypomnij o reszcie")
        .accessibilityHint("Zmienia plan na karcie, nic nie wysyła")
    }

    /// The server's other plans for this meal: a tap replaces the card (a plan with a low asks first).
    @ViewBuilder
    private var variantButtons: some View {
        if let onChooseVariant, let variants = proposal.variants, !variants.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ChipFlowLayout(spacing: 8) {
                    ForEach(variants) { variant in
                        Button {
                            if variant.needs_ack { pendingVariant = variant } else { onChooseVariant(variant) }
                        } label: {
                            Text(variant.label)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 36)
                                .background(Color.secondary.opacity(0.16), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(variantBusy)
                        .accessibilityHint("Zmienia plan na karcie, nic nie wysyła")
                    }
                }
                .opacity(variantBusy ? 0.5 : 1)
                if variantBusy {
                    Text("Przeliczam plan…").font(.caption).foregroundStyle(.secondary)
                } else if let variantError {
                    Text(variantError).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// Behind "Skąd ta dawka": the formula, the whole plan on its time line (WBT too) and every other note.
    private var planDetails: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let calculation = proposal.dose_calculation {
                DoseExplanationLine(line: calculation.line, details: calculation.details, lowersDose: calculation.lowersDose, font: .caption)
            }
            CardDoseTimeline(steps: leadingSteps + proposal.timelineSteps(loop: loop), onAction: nil, busySwitches: busySwitches)
            details
        }
    }
}

/// Before a plan that leads to a low replaces the card (card A, screen C2): the plan, why it is risky, and the way back
/// as the main button.
struct VariantRiskSheet: View {
    let variant: ConversationBolusProposal.Variant
    let loop: LoopSystemNames
    let onDecide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(variant.label)
                .font(.title3.weight(.semibold))
            HStack(alignment: .firstTextBaseline, spacing: 18) {
                if variant.insulin_now_u > 0 {
                    value(RemoteCommandFormat.units(variant.insulin_now_u), unit: "j", color: BolusProposalCard.insulinColor)
                }
                if variant.carbs_now_g > 0 {
                    value("\(variant.carbs_now_g)", unit: "g", color: BolusProposalCard.carbsColor)
                }
            }
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(Color.orange)
                VStack(alignment: .leading, spacing: 4) {
                    Text(text)
                        .font(.subheadline)
                    Text("Spokojniejszy jest plan z karty.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            Spacer(minLength: 0)
            Button {
                onDecide(false)
            } label: {
                Text("Zostaw plan z karty")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 34)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .controlSize(.large)
            Button {
                onDecide(true)
            } label: {
                Text("Zmień plan mimo to")
                    .frame(maxWidth: .infinity)
                    .frame(height: 30)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .controlSize(.large)
        }
        .padding(20)
    }

    /// The server's warning, or the forecast low when it gave none.
    private var text: String {
        if let ack = variant.ack_text, !ack.isEmpty { return ack }
        if let risk = variant.risk { return "Z tym planem prognoza schodzi do ok. \(risk.min_mgdl)." }
        return "Ten plan może prowadzić do spadku."
    }

    private func value(_ value: String, unit: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value)
                .font(.system(size: 40, weight: .light, design: .rounded).monospacedDigit())
                .foregroundStyle(color)
            Text(unit).font(.title3).foregroundStyle(.secondary)
        }
    }
}
