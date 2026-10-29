import SwiftUI

/// One step of a bolus card's plan: the dose now, each later part and the WBT reminder, in order.
public struct CardTimelineStep: Equatable, Identifiable {
    public enum State: Equatable {
        /// Will come (a reminder is set, or will be once the meal is saved).
        case planned
        /// Its reminder came: the dose waits to be given.
        case due
        case done
        /// Switched off, skipped, expired or cancelled.
        case off
    }

    public enum Action: Equatable {
        case skipPart(PlannedBolusSummary)
        case setWbtReminder(mealID: String, enabled: Bool)
        /// A reminder on the Meals tab (WBT, second dose, later part) switched off or on again.
        case setMealReminder(mealID: String, reminderID: String, enabled: Bool)

        /// The switch this action saves: the part's id, or "wbt:<meal id>" (ConversationViewModel.cardSwitchesInFlight).
        public var switchID: String {
            switch self {
            case .skipPart(let part): return part.id
            case .setWbtReminder(let mealID, _): return "wbt:\(mealID)"
            case .setMealReminder(let mealID, let reminderID, _): return "\(mealID)/\(reminderID)"
            }
        }
    }

    public let id: String
    /// "Teraz", "13:50", "gdy rośnie", "za ok. 2,5 h"
    public let time: String
    /// "1,8 j · 28 g", "Bolus: ok. 1,8 j", "WBT: ok. 0,7 j (1,8 WBT)"
    public let detail: String
    /// "Przypomnienie o 13:50", "Podana o 13:02 (Ewa)", "wyłączone"
    public let note: String?
    public let state: State
    public let isWbt: Bool
    /// "Wyłącz" / "Włącz" and what it does; nil: nothing to switch.
    public let actionTitle: String?
    public let action: Action?
    /// The step's own icon while it is to come ("square.and.pencil" for carbs alone, "drop.fill" for rescue carbs);
    /// nil: a syringe now, a clock later, fork and knife for WBT.
    public var symbol: String? = nil
    /// Its colour (nil: the accent for insulin now, grey otherwise, orange for WBT).
    public var symbolColor: Color? = nil
}

public extension ConversationBolusProposal {
    /// The whole plan of the card on one time line: now, every later part (as planned, or as it stands once the meal was
    /// saved) and the WBT reminder (planned, or set for the saved meal).
    func timelineSteps(loop: LoopSystemNames) -> [CardTimelineStep] {
        var steps: [CardTimelineStep] = []
        let sent = state == "SENT"
        // Carbs alone are an entry, not a dose: a note icon and no syringe.
        let carbsOnly = shownInsulinU <= 0
        let nowNote: String? = carbsOnly
            ? "bez insuliny"
            : dose_adjustment.map { "\(RemoteCommandFormat.units($0.reduced_by_u)) j mniej, bo glukoza spada" }
                ?? correction.map { "w tym korekta \(RemoteCommandFormat.units($0.dose_u)) j" }
        // Once sent, "Teraz" becomes the time it was sent (an old answer must not say "now").
        let sentAt = command?.authorized_at.flatMap(ServerDate.parse).map(LoopFormat.clock)
        steps.append(CardTimelineStep(
            id: "now", time: sent ? (sentAt ?? "Wysłano") : "Teraz",
            detail: carbsOnly ? "Wpis \(shownCarbsG) g do \(loop.genitive)" : shownCarbsG > 0 ? "\(RemoteCommandFormat.units(shownInsulinU)) j · \(shownCarbsG) g" : "\(RemoteCommandFormat.units(shownInsulinU)) j",
            note: nowNote,
            state: sent && command?.status == "SUCCEEDED" ? .done : .planned, isWbt: false, actionTitle: nil, action: nil,
            symbol: carbsOnly ? "square.and.pencil" : nil
        ))

        if let parts = planned_parts, !parts.isEmpty {
            for part in parts {
                steps.append(CardTimelineStep.plannedPart(part))
            }
        } else if let split {
            for (index, part) in ([split] + (split.more_parts ?? [])).enumerated() {
                let dose = part.fixed_insulin_u.map { "\(RemoteCommandFormat.units($0)) j" } ?? "ok. \(RemoteCommandFormat.units(part.later_insulin_u)) j"
                let isCondition = LaterTriggerText.condition(trigger: part.laterTrigger, thresholdMgdl: part.threshold_mgdl) != nil
                steps.append(CardTimelineStep(
                    id: "plan-\(index)",
                    time: LaterTriggerText.short(trigger: part.laterTrigger, afterMinutes: part.later_after_minutes, thresholdMgdl: part.threshold_mgdl),
                    detail: part.later_carbs_g > 0 ? "\(dose) · \(part.later_carbs_g) g" : dose,
                    note: (isCondition && part.later_after_minutes > 0 ? "przypomnienie, najwcześniej za \(part.later_after_minutes) min" : "przypomnienie")
                        + CardTimelineStep.doseCarbsNote(doseCarbs: part.dose_carbs_g, ownCarbs: part.later_carbs_g),
                    state: .planned, isWbt: false, actionTitle: nil, action: nil
                ))
            }
        }

        let wbtDose = wbt_plan?.standard_dose_u.map { "WBT ok. \(RemoteCommandFormat.units($0)) j" } ?? "WBT: dawka przy przypomnieniu"
        if let wbt = wbt_reminder, let given = wbt.given_units {
            // Given: the step is the dose, like on the meal's tile.
            let time = ServerDate.parse(wbt.remind_at).map(LoopFormat.clock) ?? ""
            steps.append(CardTimelineStep(
                id: "wbt", time: time, detail: "WBT \(RemoteCommandFormat.units(given)) j", note: "podano",
                state: .done, isWbt: true, actionTitle: nil, action: nil
            ))
        } else if let wbt = wbt_reminder {
            let time = ServerDate.parse(wbt.remind_at).map(LoopFormat.clock) ?? ""
            let state: CardTimelineStep.State = !wbt.isPending ? (wbt.status == "SENT" ? .due : .off) : (wbt.enabled ? .planned : .off)
            let canSwitch = wbt.isPending && (ServerDate.parse(wbt.remind_at).map { $0 > Date() } ?? false)
            steps.append(CardTimelineStep(
                id: "wbt", time: time, detail: wbtDose,
                note: !wbt.isPending ? (wbt.status == "SENT" ? "przypomnienie przyszło" : wbt.status == "MISSED" ? "minęło, sprawdź, czy WBT jest potrzebne" : "pominięte") : (wbt.enabled ? "przypomnienie o \(time)" : "wyłączone"),
                state: state, isWbt: true,
                actionTitle: canSwitch ? (wbt.enabled ? "Wyłącz" : "Włącz") : nil,
                action: canSwitch ? .setWbtReminder(mealID: wbt.meal_id, enabled: !wbt.enabled) : nil
            ))
        } else if let plan = wbt_plan, plan.auto, command?.meal_record_id == nil {
            steps.append(CardTimelineStep(
                id: "wbt-plan", time: "za ok. \(Self.hours(plan.after_minutes))", detail: wbtDose,
                note: "przypomnienie", state: .planned, isWbt: true, actionTitle: nil, action: nil
            ))
        }
        return steps
    }

    private static func decimal(_ value: Double) -> String {
        String(format: "%.1f", value).replacingOccurrences(of: ".", with: ",")
    }

    private static func hours(_ minutes: Int) -> String {
        minutes % 60 == 0 ? "\(minutes / 60) h" : "\(decimal(Double(minutes) / 60)) h"
    }
}

extension CardTimelineStep {
    /// A planned later part as it stands (with "Wyłącz" while it can still be switched off).
    /// " · dawka na 13 g" when a later dose also covers carbs given earlier without insulin (the line shows its own grams).
    static func doseCarbsNote(doseCarbs: Int?, ownCarbs: Int) -> String {
        guard let doseCarbs, doseCarbs > ownCarbs, ownCarbs > 0 else { return "" }
        return " · dawka na \(doseCarbs) g"
    }

    static func plannedPart(_ part: PlannedBolusSummary) -> CardTimelineStep {
        let due = part.dueDate.map(LoopFormat.clock) ?? ""
        let condition = LaterTriggerText.condition(trigger: part.laterTrigger, thresholdMgdl: part.threshold_mgdl)
        let time: String
        switch part.status {
        case "GIVEN": time = part.resolved_at.flatMap(ServerDate.parse).map(LoopFormat.clock) ?? due
        case "SCHEDULED": time = condition == nil ? due : LaterTriggerText.short(trigger: part.laterTrigger, afterMinutes: part.delay_minutes, thresholdMgdl: part.threshold_mgdl)
        default: time = due
        }
        let dose: String
        if part.status == "GIVEN" {
            dose = part.given_insulin_u.map { "\(RemoteCommandFormat.units($0)) j" } ?? "podano"
        } else {
            dose = part.fixed_insulin_u.map { "\(RemoteCommandFormat.units($0)) j" } ?? "ok. \(RemoteCommandFormat.units(part.planned_insulin_u)) j"
        }
        let state: CardTimelineStep.State = switch part.status {
        case "GIVEN": .done
        case "NOTIFIED": .due
        case "SCHEDULED": .planned
        default: .off
        }
        // Time and dose are on the line already: the note says only who and how it was settled.
        let note: String = switch part.status {
        case "GIVEN": part.resolved_by_name.map { "podana · \($0)" } ?? "podana"
        case "SKIPPED": part.resolved_by_name.map { "wyłączona · \($0)" } ?? "wyłączona"
        default: part.statusLine
        }
        return CardTimelineStep(
            id: part.id, time: time,
            detail: part.carbs_g > 0 ? "\(dose) · \(part.carbs_g) g" : dose,
            note: note + (part.status == "GIVEN" ? "" : doseCarbsNote(doseCarbs: part.dose_carbs_g, ownCarbs: part.carbs_g)), state: state, isWbt: false,
            actionTitle: part.canGive ? "Wyłącz" : nil,
            action: part.canGive ? .skipPart(part) : nil
        )
    }

}

/// The card's plan as a vertical time line: a dot per step joined by a line, each with its time, dose and switch.
struct CardDoseTimeline: View {
    let steps: [CardTimelineStep]
    let onAction: ((CardTimelineStep.Action) -> Void)?
    /// Switches being saved (see `CardTimelineStep.Action.switchID`): their buttons wait.
    var busySwitches: Set<String> = []
    /// A later part waiting for "Wyłącz" to be confirmed: unlike the WBT reminder, it cannot be switched on again.
    @State private var pendingSkip: CardTimelineStep?

    var body: some View {
        EqualStepRows(spacing: Self.rowSpacing) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .top, spacing: 10) {
                    icon(step)
                        .font(.subheadline)
                        .frame(width: 22, height: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(step.time)
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                            Text(step.detail)
                                .font(.subheadline.monospacedDigit())
                                .foregroundStyle(step.state == .off ? .secondary : .primary)
                                .strikethrough(step.state == .off)
                            Spacer(minLength: 4)
                            if step.note == nil { actionButton(step) }
                        }
                        // The switch sits on the note's line, so the dose keeps the whole top line.
                        if let note = step.note {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(note)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 4)
                                actionButton(step)
                            }
                        }
                    }
                }
                // Every row as tall as the tallest (EqualStepRows): the dots are evenly spaced with or without a note.
                .frame(maxHeight: .infinity, alignment: .top)
                // The line to the next dot spans this row and the gap below it, never more: a line that fills the
                // height offered pushed the steps apart in the newest answer (as tall as the chat, to sit at the top).
                .background(alignment: .topLeading) {
                    if index < steps.count - 1 {
                        Rectangle()
                            .fill(Color.secondary.opacity(0.3))
                            .frame(width: 1.5)
                            .padding(.top, 22)
                            .padding(.bottom, -Self.rowSpacing)
                            .padding(.leading, 10.25)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .confirmationDialog(
            Self.skipTitle,
            isPresented: Binding(get: { pendingSkip != nil }, set: { if !$0 { pendingSkip = nil } }),
            titleVisibility: .visible,
            presenting: pendingSkip
        ) { step in
            Button("Wyłącz \(step.detail)", role: .destructive) {
                if let action = step.action { onAction?(action) }
                pendingSkip = nil
            }
            Button("Anuluj", role: .cancel) { pendingSkip = nil }
        } message: { _ in
            Text(Self.skipMessage)
        }
    }

    /// The confirmation of switching off a later part, here and on the planned part's own screen.
    static let skipTitle = "Wyłączyć tę dawkę?"
    static let skipMessage = "Przypomnienie o niej nie przyjdzie do żadnego z opiekunów i nie da się jej włączyć ponownie."

    private static let rowSpacing: CGFloat = 12

    @ViewBuilder
    private func actionButton(_ step: CardTimelineStep) -> some View {
        if let title = step.actionTitle, let action = step.action, let onAction {
            Button(title) {
                if case .skipPart = action { pendingSkip = step } else { onAction(action) }
            }
            .font(.footnote.weight(.semibold))
            .buttonStyle(.borderless)
            .disabled(busySwitches.contains(action.switchID))
            .accessibilityLabel("\(title): \(step.time), \(step.detail)")
        }
    }

    @ViewBuilder
    private func icon(_ step: CardTimelineStep) -> some View {
        switch step.state {
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .due:
            Image(systemName: "bell.badge.fill").foregroundStyle(.orange)
        case .off:
            Image(systemName: "bell.slash").foregroundStyle(.secondary)
        case .planned:
            if let symbol = step.symbol {
                Image(systemName: symbol).foregroundStyle(step.symbolColor ?? .secondary)
            } else if step.id == "now" {
                Image(systemName: "syringe.fill").foregroundStyle(step.symbolColor ?? .accentColor)
            } else if step.isWbt {
                // WBT: insulin for later (protein and fat), not the meal itself.
                Image(systemName: "hourglass.circle.fill").foregroundStyle(.orange)
            } else {
                Image(systemName: "clock.fill").foregroundStyle(step.symbolColor ?? Color.accentColor.opacity(0.7))
            }
        }
    }
}

/// The time line's rows one under another, each as tall as the tallest: a step without a note ("Teraz") takes the same
/// room as one with "przypomnienie". The height offered is ignored (the newest answer offers the chat's height).
private struct EqualStepRows: Layout {
    let spacing: CGFloat

    private func rowHeight(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGFloat {
        subviews.map { $0.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)).height }.max() ?? 0
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        let height = rowHeight(proposal, subviews)
        return CGSize(width: width, height: subviews.isEmpty ? 0 : height * CGFloat(subviews.count) + spacing * CGFloat(subviews.count - 1))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let height = rowHeight(ProposedViewSize(width: bounds.width, height: nil), subviews)
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(x: bounds.minX, y: bounds.minY + CGFloat(index) * (height + spacing)),
                proposal: ProposedViewSize(width: bounds.width, height: height)
            )
        }
    }
}
