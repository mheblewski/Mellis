import SwiftUI
import Charts

/// What the rescue carbs sheet opens with: the alert's dose (no proposal id) or a chat card's.
struct RescueCarbsSheetRequest: Identifiable, Equatable {
    let id = UUID()
    /// nil: empty field (no therapy profile).
    let grams: Double?
    let proposalID: String?
    /// "Proponuję 4 g węglowodanów" or the card's "Dosłodzenie 8 g", shown under the field.
    let hint: String?
    /// stale-alerts.v1: the alert or card is over 30 min old: the sheet only logs (no send to the loop), saying why.
    var sendBlockedReason: String? = nil
}

/// Top of a rescue carbs alert's conversation (rescue-carbs.v1): the level, glucose now and where it is heading, the
/// CGM curve with the forecast, the dose and how it was computed. No buttons (owner decision 2026-11-01: never used;
/// carbs are given in the loop, or logged with a chat card). Once logged it shows who gave how much and when; once
/// declined (an older build), that no reminder follows. The chat about the alert continues below it.
struct RescueCarbsSection: View {
    @Environment(\.loopSystem) private var loopSystem
    let rescue: ConversationRescueCarbs
    /// Why the last sheet closed without saving (e.g. the other caregiver logged it first).
    let notice: String?
    /// stale-alerts.v1: older than 30 min since its push, the alert is history: a badge and its glucose "wtedy".
    var stale: AlertStaleness.Stale? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            HStack(spacing: 8) {
                if stale != nil, let glucose = rescue.alertGlucoseLine {
                    // The alert's reading, not the glucose now.
                    RescueStatPill(title: "wtedy:", value: glucose)
                        .accessibilityIdentifier("rescue-carbs-glucose-then")
                } else if let glucose = rescue.glucoseLine {
                    RescueStatPill(title: "teraz", value: glucose)
                }
            }
            if let prediction = rescue.predictionLine {
                Label(prediction, systemImage: "chart.line.downtrend.xyaxis")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if rescue.glucose_readings.count >= 2 {
                RescueGlucoseChart(readings: rescue.glucose_readings, prediction: rescue.chartForecast)
                    .frame(height: 140)
            }

            Divider()

            if let treatment = rescue.treatmentLine(loop: loopSystem.names) {
                Label(treatment, systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Brand.rescue)
                    .accessibilityIdentifier("rescue-carbs-treatment")
            } else if let declined = rescue.declinedLine {
                VStack(alignment: .leading, spacing: 4) {
                    Label(declined, systemImage: "hand.raised.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("rescue-carbs-declined")
                    Text(rescue.declineFollowUpLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                if let closed = rescue.closedLine {
                    Label(closed, systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Text(rescue.proposalLine)
                    .font(rescue.proposedGrams == nil ? .headline : .title3.weight(.bold))
                    .foregroundStyle(rescue.proposedGrams == nil ? Color.orange : Color.primary)
            }

            ForEach(Array((rescue.proposal?.warnings ?? []).enumerated()), id: \.offset) { _, warning in
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let explanation = rescue.proposal?.explanation, !explanation.isEmpty {
                RescueExplanation(lines: explanation)
            }

            if let notice {
                Label(notice, systemImage: "person.2.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        .padding(14)
        .frame(maxWidth: 680, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(levelColor.opacity(stale == nil ? 0.07 : 0.035))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(levelColor.opacity(stale == nil ? 0.25 : 0.12), lineWidth: 1)
        )
    }

    private var levelColor: Color {
        rescue.levelKind == .predictedLow ? .orange : .red
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: rescue.levelKind == .urgentLow ? "exclamationmark.triangle.fill" : "arrow.down.heart.fill")
                    .foregroundStyle(stale == nil ? levelColor : .secondary)
                Text(rescue.title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(stale == nil ? Color.primary : Color.secondary)
                Spacer(minLength: 0)
                if let detectedAt = rescue.notified_at ?? rescue.detected_at {
                    Text("\(HypoFormat.day(detectedAt)), \(HypoFormat.time(detectedAt))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let stale {
                StaleAlertBadge(stale: stale)
            }
        }
    }
}

/// "Jak to policzono": the server's lines (forecast, CSF, formula), collapsed by default.
private struct RescueExplanation: View {
    let lines: [String]
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack {
                    Text("Jak to policzono")
                    Spacer()
                    Image(systemName: "chevron.down")
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}

private struct RescueStatPill: View {
    let title: String
    let value: String

    var body: some View {
        HStack(spacing: 4) {
            Text(title)
                .foregroundStyle(.secondary)
            Text(value)
                .fontWeight(.semibold)
        }
        .font(.footnote)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color.secondary.opacity(0.1)))
    }
}

/// CGM readings around the alert with the 70 mg/dL line; the forecast continues dashed from the last reading.
struct RescueGlucoseChart: View {
    let readings: [RescueGlucosePoint]
    let prediction: [RescueGlucosePoint]

    private func points(_ values: [RescueGlucosePoint]) -> [(date: Date, value: Double)] {
        values.compactMap { point in point.date.map { ($0, point.value) } }.sorted { $0.date < $1.date }
    }

    var body: some View {
        let measured = points(readings)
        var forecast = points(prediction).filter { point in measured.last.map { point.date > $0.date } ?? true }
        if let last = measured.last, !forecast.isEmpty {
            forecast.insert(last, at: 0)
        }
        let maxValue = max(180, ((measured + forecast).map(\.value).max() ?? 180) + 20)
        let minValue = min(40, ((measured + forecast).map(\.value).min() ?? 40) - 10)

        return Chart {
            RuleMark(y: .value("Próg", 70))
                .foregroundStyle(Color.red.opacity(0.6))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            ForEach(measured, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "CGM"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.accentColor)
            }
            ForEach(forecast, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value), series: .value("Seria", "Prognoza"))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.orange)
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 4]))
            }
        }
        .chartYScale(domain: minValue...maxValue)
        .chartXAxis {
            AxisMarks(values: .stride(by: .minute, count: 30)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.hour().minute())
            }
        }
        .accessibilityLabel("Wykres glukozy z prognozą")
    }
}

// MARK: - Sheet

/// "Podano dosłodzenie" / "Zatwierdź Y g": how many grams and when. Sent to Trio by default (whole grams, now, then the
/// remote confirmation with Face ID), or with "Nie wysyłaj do Trio" saved in GlucoMind only (any time in the last 2 h).
struct RescueCarbsLogSheet: View {
    @Environment(\.loopSystem) private var loopSystem
    let request: RescueCarbsSheetRequest
    let isSaving: Bool
    let errorMessage: String?
    /// True when the sheet should close.
    let onSave: (Double, Date) async -> Bool
    let onCancel: () -> Void
    /// Opens the Trio confirmation for these whole grams (after the sheet closed); nil where this phone cannot send.
    var onSendToTrio: ((Int) -> Void)? = nil

    @State private var gramsText = ""
    @State private var givenAt = Date()
    @State private var glucoMindOnly = false

    /// Above this one portion gets a warning (never a block): the same 20 g as the rescue cards.
    static let portionWarningGrams: Double = 20

    /// The phone can send and the alert or card is current (stale-alerts.v1: an old one only logs).
    private var canSendToTrio: Bool { onSendToTrio != nil && request.sendBlockedReason == nil }

    /// The carbs go to Trio (now, whole grams) unless the caregiver chose otherwise or the phone cannot send.
    private var sendsToTrio: Bool { canSendToTrio && !glucoMindOnly }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 10) {
                        TextField("np. 4", text: $gramsText)
#if os(iOS)
                            .keyboardType(.decimalPad)
#endif
                            .font(.title2.weight(.semibold))
                            .accessibilityLabel("Węglowodany w gramach")
                        Text("g")
                            .foregroundStyle(.secondary)
                        Stepper("Zmień o 1 g", onIncrement: increment, onDecrement: decrement)
                            .labelsHidden()
                    }
                } header: {
                    Text("Węglowodany")
                } footer: {
                    if !gramsText.isEmpty && grams == nil {
                        Text("Podaj od 1 do 50 g (co 0,5 g).")
                            .foregroundStyle(.red)
                    } else if sendsToTrio, let grams, grams != grams.rounded() {
                        Text("\(loopSystem.names.capitalized) przyjmuje pełne gramy: wyślę \(Int(grams.rounded(.toNearestOrAwayFromZero))) g.")
                    } else if let grams, grams > RescueCarbsLogSheet.portionWarningGrams {
                        // The app's rule: one portion at most 20 g, then the 15-minute check (the caregiver may still give more).
                        Text("Ponad \(Int(RescueCarbsLogSheet.portionWarningGrams)) g naraz: zwykle podaje się do 20 g i sprawdza glukozę po 15 min.")
                            .foregroundStyle(.orange)
                    } else if let hint = request.hint {
                        Text(hint)
                    }
                }

                if canSendToTrio {
                    Section {
                        Toggle("Nie wysyłaj do \(loopSystem.names.genitive)", isOn: $glucoMindOnly)
                    } footer: {
                        Text(glucoMindOnly
                            ? "Zapiszę tylko w aplikacji Mellis: \(loopSystem.names.capitalized) nie policzy ich w COB, a wzrost po nich może dać dodatkową insulinę."
                            : "\(loopSystem.names.capitalized) wpisze dosłodzenie z obecną godziną, bez insuliny. Podane wcześniej? Wybierz „Nie wysyłaj do \(loopSystem.names.genitive)”, żeby wpisać godzinę.")
                    }
                }

                if !sendsToTrio {
                    Section {
                        // Bounded by the time now, not when the sheet opened: carbs given after that can still be picked.
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            DatePicker("Podano o", selection: $givenAt, in: context.date.addingTimeInterval(-2 * 3_600)...context.date, displayedComponents: [.hourAndMinute])
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack(spacing: 8) {
                            if isSaving {
                                ProgressView()
                            }
                            Text(isSaving ? "Zapisuję…" : sendsToTrio ? "Wyślij do \(loopSystem.names.genitive)" : "Zapisz w Mellis")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(isSaving || grams == nil)
                    .accessibilityIdentifier("rescue-carbs-save")
                } footer: {
                    if let reason = request.sendBlockedReason {
                        Text(reason)
                            .accessibilityIdentifier("rescue-carbs-log-only")
                    } else if onSendToTrio == nil {
                        Text("Ten telefon nie wysyła poleceń do \(loopSystem.names.genitive): zapiszę tylko w aplikacji Mellis.")
                    }
                }
            }
            .navigationTitle("Dosłodzenie")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj", action: onCancel)
                        .disabled(isSaving)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            givenAt = Date()
            gramsText = request.grams.map(RescueCarbsFormat.grams) ?? ""
        }
    }

    private var grams: Double? {
        RescueCarbsFormat.parseGrams(gramsText)
    }

    private func increment() {
        let current = RescueCarbsFormat.parseGrams(gramsText) ?? 0
        gramsText = RescueCarbsFormat.grams(min(RescueCarbsFormat.gramsRange.upperBound, (current + 1).rounded(.down)))
    }

    private func decrement() {
        let current = RescueCarbsFormat.parseGrams(gramsText) ?? 2
        gramsText = RescueCarbsFormat.grams(max(RescueCarbsFormat.gramsRange.lowerBound, (current - 1).rounded(.up)))
    }

    private func save() async {
        guard let grams else { return }
        if sendsToTrio, let onSendToTrio {
            let whole = max(1, Int(grams.rounded(.toNearestOrAwayFromZero)))
            onCancel()
            // The Trio confirmation is a sheet of its own: it opens once this one has gone.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { onSendToTrio(whole) }
            return
        }
        if await onSave(grams, min(givenAt, Date())) {
            onCancel()
        }
    }
}

// MARK: - Chat card

/// A rescue dose the AI proposed in a chat: "Dosłodzenie Y g", why, and "Zatwierdź Y g" (the same sheet). Once rescue
/// carbs are logged for the alert (or, outside an alert's chat, for this card) the card only says how much was logged.
struct RescueCarbProposalCard: View {
    @Environment(\.loopSystem) private var loopSystem
    let proposal: ConversationRescueCarbProposal
    let treatment: RescueCarbsTreatment?
    /// False in an ordinary conversation (kept for callers; the sheet says where the carbs go).
    var inAlert = true
    /// nil hides the button.
    let onConfirm: (() -> Void)?
    /// Inside an option of the answer: no frame of its own.
    var embedded = false
    /// stale-alerts.v1: why the card only logs now (proposed over 30 min ago): nothing is sent to the loop from it.
    var staleReason: String? = nil

    @State private var showsDetails = false

    var body: some View {
        let decided = Self.decidedLine(proposal: proposal, treatment: treatment, loop: loopSystem.names)
        VStack(alignment: .leading, spacing: 0) {
            // Inside an option the timeline row says it all.
            if !embedded || proposal.isSuperseded {
            HStack(spacing: 8) {
                Image(systemName: "drop.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Brand.rescue)
                Text("Dosłodzenie")
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 6)
                if proposal.isSuperseded {
                    Text("nieaktualna")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.secondary.opacity(0.14)))
                }
            }

            }

            CardDoseTimeline(steps: [Self.timelineStep(proposal: proposal, treatment: treatment, loop: loopSystem.names)], onAction: nil)
            .padding(.top, embedded ? 0 : 10)

            if decided == nil, !proposal.isSuperseded, onConfirm != nil, let staleReason {
                StaleAlertReason(text: staleReason)
                    .padding(.top, 12)
            }
            if decided == nil, !proposal.isSuperseded, let onConfirm {
                HStack(spacing: 8) {
                    Button(action: onConfirm) {
                        Label("Podano \(RescueCarbsFormat.grams(proposal.carbs_g)) g", systemImage: "checkmark")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.rescue)
                    .controlSize(.large)
                    if let reason = proposal.reason, !reason.isEmpty {
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
                        .accessibilityLabel("Dlaczego ta dawka")
                    }
                }
                .padding(.top, 12)
            }
            if showsDetails, decided == nil, let reason = proposal.reason {
                Text(reason + " Po zatwierdzeniu trafi do \(loopSystem.names.genitive) jako dosłodzenie, chyba że wybierzesz „Nie wysyłaj do \(loopSystem.names.genitive)”.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.top, 10)
            }
        }
        .padding(.horizontal, embedded ? 0 : 15)
        .padding(.vertical, embedded ? 0 : 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(embedded ? Color.clear : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(embedded ? Color.clear : Color.secondary.opacity(0.18), lineWidth: 1))
        .opacity(proposal.isSuperseded ? 0.55 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("rescue-carb-proposal-\(proposal.id)")
    }

    /// The card as one step of a timeline: "Teraz · 7 g szybkich węgli" (done once logged).
    static func timelineStep(proposal: ConversationRescueCarbProposal, treatment: RescueCarbsTreatment?, loop: LoopSystemNames) -> CardTimelineStep {
        let decided = decidedLine(proposal: proposal, treatment: treatment, loop: loop)
        return CardTimelineStep(
            id: "rescue-\(proposal.id)", time: "Teraz", detail: "\(RescueCarbsFormat.grams(proposal.carbs_g)) g szybkich węgli",
            note: decided ?? "sok, glukoza", state: decided != nil ? .done : .planned, isWbt: false, actionTitle: nil, action: nil,
            symbol: "drop.fill", symbolColor: Brand.rescue
        )
    }

    /// "Wpisano 6 g" once the alert has a treatment (outside an alert's chat: once this card was confirmed),
    /// "Zatwierdzono" for an accepted card; nil while it can be confirmed.
    /// `loop` names where carbs sent to the loop are ("w Trio", "w Loopie"); only "is it decided" needs none.
    static func decidedLine(proposal: ConversationRescueCarbProposal, treatment: RescueCarbsTreatment?, loop: LoopSystemNames = LoopSystemKind.unknown.names) -> String? {
        if treatment == nil, let logged = proposal.logged {
            let time = ServerDate.parse(logged.given_at).map { date -> String in
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "pl_PL")
                formatter.dateFormat = "HH:mm"
                return " o \(formatter.string(from: date))"
            } ?? ""
            return "Wpisano \(RescueCarbsFormat.grams(logged.carbs_g)) g\(time) · \(logged.in_loop == true ? "w \(loop.locative)" : "tylko w Mellis")"
        }
        if let treatment {
            let grams = RescueCarbsFormat.grams(treatment.carbs_g)
            // The alert's carbs came from another card (another option): this card was not the one given.
            if let source = treatment.proposal_id, source != proposal.id, !proposal.isAccepted {
                return "Dosłodzenie już zapisane z innej karty (\(grams) g)"
            }
            return proposal.isAccepted ? "Zatwierdzono · wpisano \(grams) g" : "Wpisano \(grams) g"
        }
        return proposal.isAccepted ? "Zatwierdzono" : nil
    }
}

/// "Nieaktualne · 2 godz. temu" on an alert's header (stale-alerts.v1).
struct StaleAlertBadge: View {
    let stale: AlertStaleness.Stale

    var body: some View {
        Label(stale.badge, systemImage: "clock.arrow.circlepath")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(Color.secondary.opacity(0.14)))
            .accessibilityIdentifier("stale-alert-badge")
    }
}

/// Why an old alert only logs: "Alarm sprzed 2 godz. Do Trio nic nie wyślę; możesz zapisać, co podano."
struct StaleAlertReason: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("stale-alert-reason")
    }
}
