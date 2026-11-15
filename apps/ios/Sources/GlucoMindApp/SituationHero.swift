import SwiftUI
import UIKit
import GlucoMindCore

/// The top of Teraz when the server sends a situation (docs/product/teraz-situation): the glucose, one second number and
/// one sentence change with the situation, while the chips, the chart and the tab bar stay put. A fact rebuilds the block,
/// a guess does not: below 70 the grams are the largest thing, with a forecast the glucose stays largest.
struct SituationBlock: View {
    let situation: NowSituation
    /// For a minute after opening a push whose reason passed: "Alert z 12:36 już minął…", in the sentence's place.
    var staleLine: String? = nil
    let glucose: DashboardGlucose?
    let now: Date
    let pull: PullModel
    /// Whose "Linia dnia" this phone remembers.
    var dayLineScope = ""
    /// A row names a problem under the chart: no good news above it.
    var hidesDayLine = false
    var freshness: DashboardFreshness = .fresh
    var refreshFailed = false
    /// Shared with SituationWaiting: its loader becomes this block's trend circle.
    var badgeSpace: Namespace.ID? = nil
    /// Just in from the loader: the circle still spins on its way, the number and words come into focus.
    var arriving = false
    var onRetry: () -> Void = {}
    var onGiven: (Int) async -> Bool = { _ in false }
    var onUndo: (String) async -> Bool = { _ in false }
    var onUndoWindowEnd: () async -> Void = {}
    var onTalk: () async -> Bool = { false }
    /// v5: the bar's button opens a planned meal's page (its entry id).
    var onOpenMeal: (String) -> Void = { _ in }
    /// meal-eaten.v1: a meal's page (not a planned meal's).
    var onOpenMealRecord: (String) -> Void = { _ in }

    /// When the bar's button last changed its label: a tap right after it is ignored, the thumb aimed at the old one.
    @State private var linkChangedAt = Date.distantPast

    /// "Inna ilość" or "Zapisz węgle": the amount chosen with − and +; nil shows the plain action.
    @State private var amount: Int? = nil
    @State private var dayLine: String? = nil
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var busy = false
    @State private var failed: String? = nil
    /// Set when the block is born from the loader; cleared at once with an animation.
    @State private var entering = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.patientSwipeModel) private var swipeModel
    @ScaledMetric(relativeTo: .title3) private var sentenceSize: CGFloat = 22
    @ScaledMetric(relativeTo: .body) private var longSentenceSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var detailSize: CGFloat = 15

    /// Refreshing after a return or failed: the old words and dose may no longer hold.
    private var doubtful: Bool { freshness.dimsGlucose && !situation.isEarly }
    private var onRed: Bool { situation.isUrgentRed }
    private var isStaleReading: Bool { situation.glucose?.tone == "STALE" }
    /// The page follows the finger, so a swipe that started on a button also ends on it: that is not a tap.
    private var justSwiped: Bool { swipeModel?.justSwiped == true }
    private var textColor: Color { onRed ? .white : .primary }
    private var secondaryColor: Color { onRed ? .white.opacity(0.92) : .secondary }
    /// The second sentence: readable on every background, not the system's light grey (about 3:1).
    private var detailColor: Color { onRed ? .white.opacity(0.92) : .primary.opacity(0.65) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Its natural height, from the top: no room held for a larger number that is not there (owner, 2026-11-07).
            numbers
                .blur(radius: entering ? 14 : 0)
                .scaleEffect(entering ? 0.94 : 1, anchor: .leading)
                .opacity(entering ? 0 : 1)
            // In the undo window the sentence takes the line's place.
            if situation.state != "8u" {
                bar
                    .frame(minHeight: 24)
                    .padding(.top, 4)
            }
            words
                .padding(.top, 12)
                .offset(y: entering ? 8 : 0)
                .opacity(entering ? 0 : 1)
            dayLineRow
            action
                .padding(.top, 14)
        }
        // Owner: no reserved room for a button, the gap to the chips is always the same. The chart takes up the difference.
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(.bottom, 8)
        // Its natural height always: the chart gives way, the digits are never squeezed.
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .background(alignment: .top) {
            if onRed {
                // The red reaches the top of the screen and the block's lower edge.
                UnevenRoundedRectangle(bottomLeadingRadius: 28, bottomTrailingRadius: 28)
                    .fill(Self.urgentRed)
                    .padding(.horizontal, -24)
                    .padding(.top, -240)
                    .padding(.bottom, -2)
                    .transition(reduceMotion ? .identity : .move(edge: .top).combined(with: .opacity))
                    .accessibilityHidden(true)
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.6, dampingFraction: 0.86), value: situation.state)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: doubtful)
        .onAppear {
            guard arriving, !reduceMotion else { return }
            var start = Transaction()
            start.disablesAnimations = true
            withTransaction(start) { entering = true }
            DispatchQueue.main.async {
                withAnimation(.smooth(duration: 0.55)) { entering = false }
            }
        }
        // On the block: an empty row would never start them.
        .task(id: dayLineToken) { pickDayLine() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { pickDayLine() }
        }
    }

    /// Readable white on it at every small text size (at least 4.5:1).
    private static let urgentRed = Color(red: 0.78, green: 0.11, blue: 0.09)

    // MARK: Numbers

    private var numbers: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // The change stands on the digits' baseline. Where the digits are taller than the trend block they come down
            // by the difference instead of the circle (and its loader) going up; the room below shrinks by as much, so
            // the line under them stays put.
            HStack(alignment: .lastTextBaseline, spacing: 8) {
                glucoseNumber
                    .padding(.top, digitsDrop)
                    .padding(.bottom, -digitsDrop)
                if let glucose, !isStaleReading {
                    trend(glucose)
                }
            }
            Spacer(minLength: 0)
            if let second, !doubtful || !situation.showsDose {
                secondNumber(second)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.72, anchor: .bottomTrailing).combined(with: .opacity))
            }
        }
    }

    private var second: NowSituation.Second? { situation.second }

    /// How far the digits come down so that the change sits on their baseline with the circle where it was: the room
    /// the digits keep below their baseline, less the change's own room and the block's 10 pt.
    private var digitsDrop: CGFloat {
        guard situation.glucose != nil, !isStaleReading else { return 0 }
        let digitsBelow = -UIFont.systemFont(ofSize: glucoseSize).descender - glucoseSize * 0.1
        return max(0, digitsBelow - Self.changeBelow)
    }

    /// The trend block's room under the change's baseline: the change's own and the 10 pt under it.
    private static let changeBelow = -UIFont.systemFont(ofSize: changeSize, weight: .semibold).descender + 10

    private static let changeSize: CGFloat = 17

    private var glucoseSize: CGFloat {
        guard let value = situation.glucose?.value else { return 92 }
        if isStaleReading { return value >= 100 ? 72 : 80 }
        switch situation.second?.kind {
        case "DOSE": return 66
        case "GIVEN": return 66
        case "SOFT_DOSE": return 80
        case "FORECAST_DOSE": return 96
        case "CHECK": return 66
        default: return 132
        }
    }

    /// The weight of the digits is the urgency: calm is light, a low is the heaviest.
    private var glucoseWeight: Font.Weight {
        switch situation.state {
        case "1", "1b", "1c", "1d", "1e", "1f", "4", "4b": return .light
        case "2": return .regular
        case "2b", "3", "3c", "3e": return .semibold
        case "3a", "3b", "3d", "P": return (situation.glucose?.value ?? 0) > 180 ? .bold : .regular
        default:
            return (situation.glucose?.value ?? 100) < 70 ? .heavy : .regular
        }
    }

    private var glucoseColor: Color {
        switch situation.glucose?.tone {
        case "RED": return DashboardPalette.red
        case "AMBER": return DashboardPalette.yellow
        case "ON_RED": return .white
        default: return DashboardPalette.green
        }
    }

    @ViewBuilder
    private var glucoseNumber: some View {
        if let value = situation.glucose?.value {
            if isStaleReading {
                OutlinedNumber(text: "\(value)", size: glucoseSize)
            } else {
                Text("\(value)")
                    .font(.system(size: glucoseSize, weight: glucoseWeight))
                    .monospacedDigit()
                    .tracking(-2)
                    .contentTransition(reduceMotion ? .identity : .numericText(value: Double(value)))
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                    .foregroundStyle(glucoseColor)
                    .staleDimmed(doubtful)
                    // The font's own room above and below the digits.
                    .padding(.vertical, -glucoseSize * 0.1)
            }
        } else {
            Text("—")
                .font(.system(size: 92, weight: .bold))
                .foregroundStyle(.secondary)
        }
    }

    private func trend(_ glucose: DashboardGlucose) -> some View {
        // The arrow takes the digits' colour: amber also above 250, red only below 70.
        let level: DashboardLevel = situation.glucose?.tone == "RED" ? .alarm : situation.glucose?.tone == "AMBER" ? .warning : .normal
        return VStack(spacing: 6) {
            TrendBadge(
                direction: arriving ? nil : GlucoseTrend.direction(nightscout: glucose.direction, delta: glucose.delta.map(Double.init)),
                level: arriving ? .normal : level,
                activity: pull.activity,
                // glucose-first.v1: the new number's arrow at once; the words below say the rest is on its way.
                refreshing: (freshness == .refreshing && !situation.isEarly) || arriving,
                dimmed: doubtful,
                tintOverride: onRed ? .white : nil
            )
            .heroMatched(id: "trend", in: badgeSpace)
            if let delta = glucose.delta {
                Text(DashboardFormat.signedDelta(delta))
                    .font(.system(size: Self.changeSize, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(onRed ? Color.white : glucoseColor)
                    .staleDimmed(doubtful)
                    .accessibilityLabel("Zmiana \(DashboardFormat.signedDelta(delta)) mg/dL na 5 minut")
            }
        }
        .padding(.bottom, 10)
        // Without a change the circle stays where it is with one.
        .alignmentGuide(.lastTextBaseline) { glucose.delta == nil ? $0[.bottom] - Self.changeBelow : $0[.lastTextBaseline] }
    }

    @ViewBuilder
    private func secondNumber(_ second: NowSituation.Second) -> some View {
        switch second.kind {
        case "DOSE":
            amountView(label: second.label, value: second.value, unit: second.unit, note: second.note, size: 88)
        case "GIVEN":
            amountView(label: second.label, value: second.value, unit: second.unit, note: nil, size: 88)
        case "SOFT_DOSE":
            amountView(label: second.label, value: second.value, unit: second.unit, note: nil, size: 50)
        case "FORECAST_DOSE":
            amountView(label: second.label, value: second.value, unit: second.unit, note: nil, size: 50)
                .padding(.bottom, 4)
                .overlay(alignment: .bottom) {
                    Line()
                        .stroke(style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                        .foregroundStyle(DashboardPalette.yellow)
                        .frame(height: 2)
                }
        case "CHECK":
            if situation.checkWaitsForReading(now: now) {
                // Counted from the check's time, not the last reading (texts review, 2026-11-09).
                amountView(label: "Odczyt spóźnia się o", value: StaleReading.shortSpan(minutes: situation.checkMinutesPastDue(now: now) ?? 0), unit: nil, note: nil, size: 80)
            } else if situation.checkIsDue(now: now) {
                // Due, and the reading is on its usual way: no stuck "1 min", no alarm either.
                EmptyView()
            } else {
                // A countdown, not a clock time: shorter than the glucose and it answers "how long" (owner, 2026-11-13).
                let minutes = situation.checkMinutesLeft(now: now).map { "\($0) min" } ?? second.value
                amountView(label: "Kolejne sprawdzenie za", value: minutes, unit: nil, note: nil, size: 88)
            }
        default:
            let minutes = situation.glucose?.observedAt.map { StaleReading.shortSpan(minutes: DashboardFormat.wholeMinutes(since: $0, now: now)) } ?? second.value
            amountView(label: nil, value: minutes, unit: second.unit, note: nil, size: 80)
        }
    }

    /// "5 g" or "15 min", as on the mock-up: the words start at the digit's left edge, the unit stands beside the digit with
    /// its last line on the digit's baseline, and the digit keeps its full size (the glucose gives way first).
    private func amountView(label: String?, value: String, unit: String?, note: String?, size: CGFloat) -> some View {
        let parts = value.split(separator: " ", maxSplits: 1).map(String.init)
        let large = size >= 80
        return VStack(alignment: .leading, spacing: 0) {
            if let label {
                Text(label)
                    .font(.system(size: large ? 17 : 13, weight: .semibold))
                    .foregroundStyle(large ? textColor : secondaryColor)
                    .lineLimit(1)
                    .fixedSize()
            }
            HStack(alignment: .lastTextBaseline, spacing: 3) {
                Text(parts.first ?? value)
                    .font(.system(size: size, weight: .heavy))
                    .monospacedDigit()
                    .tracking(-2)
                    .contentTransition(reduceMotion ? .identity : .numericText())
                    .lineLimit(1)
                    .fixedSize()
                VStack(alignment: .leading, spacing: 0) {
                    if parts.count > 1 {
                        Text(parts[1]).font(.system(size: large ? 26 : 18, weight: .bold)).fixedSize()
                    }
                    if let unit {
                        Text(unit).font(.system(size: large ? 13 : 12, weight: .semibold)).lineLimit(1).fixedSize()
                    }
                }
            }
            // The font's own room above and below the digit would push the words away from it.
            .padding(.top, -size * 0.1)
            .padding(.bottom, -size * 0.15)
            .foregroundStyle(textColor)
            if let note {
                Text(note)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(textColor)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.top, 2)
            }
        }
        .layoutPriority(1)
        .accessibilityElement(children: .combine)
    }

    // MARK: The bar

    /// One line, or two when large text no longer fits it: nothing is cut.
    private var bar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                ageLine
                Spacer(minLength: 4)
                talkButton
            }
            VStack(alignment: .leading, spacing: 4) {
                ageLine
                talkButton
            }
        }
        .font(.footnote)
        .foregroundStyle(secondaryColor)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    @ViewBuilder
    private var ageLine: some View {
            if refreshFailed {
                Button { if !justSwiped { onRetry() } } label: {
                    (ageText + Text(" · ") + Text("nie udało się odświeżyć").foregroundStyle(onRed ? Color.white : DashboardPalette.red).fontWeight(.semibold)
                        + Text(" · ") + Text("Odśwież").foregroundStyle(onRed ? Color.white : Brand.interactive).fontWeight(.semibold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Nie udało się odświeżyć. Spróbuj ponownie")
            } else {
                ageText
            }
    }

    /// v5: the server's button for this sentence, or none; an older server: "Porozmawiaj ›" as before.
    @ViewBuilder
    private var talkButton: some View {
        if !situation.linkSent {
            legacyTalkButton
        } else if let link = situation.link {
            Button {
                guard Date().timeIntervalSince(linkChangedAt) >= 1 else { return }
                open(link)
            } label: {
                Text("\(link.label) ›")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(onRed ? Color.white : Brand.interactive)
                    .fixedSize()
                    .contentTransition(.opacity)
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .accessibilityLabel(link.kind == "MEAL_PLAN_ENTRY" ? "Otwórz posiłek z planu: \(link.label)" : link.label)
            .transition(.opacity)
            .onChange(of: link) { _, _ in linkChangedAt = Date() }
        }
    }

    private func open(_ link: NowSituation.Link) {
        switch link.kind {
        case "MEAL_PLAN_ENTRY":
            if let entry = link.entry_id { onOpenMeal(entry) }
        case "CONVERSATION":
            perform(failure: "Nie udało się otworzyć rozmowy. Spróbuj jeszcze raz.") { await onTalk() }
        case "MEAL":
            if let meal = link.meal_id { onOpenMealRecord(meal) }
        default:
            break
        }
    }

    private var legacyTalkButton: some View {
        Button {
            perform(failure: "Nie udało się otworzyć rozmowy. Spróbuj jeszcze raz.") { await onTalk() }
        } label: {
            Text("Porozmawiaj ›")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(onRed ? Color.white : Brand.interactive)
                .fixedSize()
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Porozmawiaj o tej sytuacji")
    }

    private var ageText: Text {
        guard let at = situation.glucose?.observedAt ?? glucose?.observedAt else { return Text("Brak odczytu") }
        let minutes = DashboardFormat.wholeMinutes(since: at, now: now)
        // Over 10 minutes old the age is in the colour of the forecast's underline, over 15 in red.
        // On the red screen everything stays white.
        let oldColor: Color? = onRed ? nil : minutes > 15 ? DashboardPalette.red : minutes > 10 ? DashboardPalette.yellow : nil
        let age = Text(isStaleReading ? "odczyt z \(at.formatted(.dateTime.hour().minute()))" : minutes < 1 ? "przed chwilą" : StaleReading.ageText(minutes: minutes))
        // No colour at all when it is not old: the line's grey stays.
        let shown = oldColor.map { age.foregroundColor($0) } ?? age
        return isStaleReading ? shown : Text("mg/dL · ") + shown
    }

    // MARK: The words

    /// Glucagon and other long sentences on red are smaller, never cut.
    private var mainSize: CGFloat { situation.sentence.count > 90 ? longSentenceSize : sentenceSize }

    private var words: some View {
        VStack(alignment: .leading, spacing: 4) {
            if situation.isEarly {
                // glucose-first.v1: the number is new, the words wait for the rest of the read.
                ShimmeringText(text: "Wczytuję dane pompy i pętli…")
                    .font(.system(size: sentenceSize, weight: .semibold))
                    .transition(.opacity)
            } else if doubtful && freshness == .refreshing {
                Text("Sprawdzam aktualny odczyt…")
                    .font(.system(size: sentenceSize, weight: .semibold))
                    .foregroundStyle(secondaryColor)
                    .transition(.opacity)
            } else {
                Group {
                    if staleLine == nil, let praise = praiseParts {
                        PraiseSentence(word: praise.word, rest: praise.rest, closing: praise.closing)
                    } else if situation.action?.kind == "UNDO" {
                        // Counts down here: the seconds do not wait for a read.
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(NowSituation.noBreaks(NowSituation.undoSentence(seconds: situation.undoSecondsLeft(now: context.date) ?? 1, serverSentence: situation.sentence)))
                                .contentTransition(.numericText())
                        }
                    } else if let staleLine {
                        Text(NowSituation.noBreaks(staleLine))
                    } else if let split = firstOrder {
                        // The first thing to do stands apart and large; what follows stays together, with "112" to call.
                        VStack(alignment: .leading, spacing: 4) {
                            Text(NowSituation.noBreaks(split.order))
                                .font(.system(size: sentenceSize, weight: .semibold))
                            Text(attributed(split.rest))
                                .font(.system(size: longSentenceSize, weight: .semibold))
                        }
                    } else if !situation.sentence.trimmingCharacters(in: .whitespaces).isEmpty {
                        // Since now-situation.v3 an empty sentence is an answer: nothing worth saying, no empty line.
                        Text(mainSentence)
                    } else if let line = sentenceDayLine {
                        // Nothing else to say: the day line is the message, in the sentence's place (owner, 2026-11-13).
                        if let calm = Self.calmParts(line) {
                            PraiseSentence(word: calm.word, rest: calm.rest)
                        } else {
                            Text(NowSituation.noBreaks(line))
                        }
                    }
                }
                .font(.system(size: mainSize, weight: .semibold))
                .foregroundStyle(textColor)
                .tint(textColor)
                .fixedSize(horizontal: false, vertical: true)
                .id(situation.sentence + "|" + (sentenceDayLine ?? ""))
                .transition(.opacity)
                if let failed {
                    Text(failed)
                        .font(.system(size: detailSize, weight: .semibold))
                        .foregroundStyle(onRed ? Color.white : DashboardPalette.red)
                        .fixedSize(horizontal: false, vertical: true)
                } else if staleLine == nil, let detail = situation.detail {
                    Text(NowSituation.noBreaks(detail))
                        .font(.system(size: detailSize))
                        .foregroundStyle(detailColor)
                        .fixedSize(horizontal: false, vertical: true)
                        .id(detail)
                        .transition(.opacity)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The whole sentence leads to the conversation too, except beside an action, so nobody leaves the screen by accident.
        .contentShape(Rectangle())
        .onTapGesture {
            guard situation.action == nil, !situation.state.hasPrefix("6"), !situation.state.hasPrefix("7"), !doubtful else { return }
            // v5: the sentence opens what its button opens, and nothing when it has none.
            if situation.linkSent {
                if let link = situation.link { open(link) }
                return
            }
            perform(failure: "Nie udało się otworzyć rozmowy. Spróbuj jeszcze raz.") { await onTalk() }
        }
    }

    /// Praise opens with its word ("Pięknie."), which gets the colour and the sweep of light; now and then it closes
    /// with "Brawo 👏" instead (owner, 2026-11-12), animated the same way at the end.
    private var praiseParts: (word: String, rest: String, closing: Bool)? {
        guard ["1", "1b", "1c"].contains(situation.state) else { return nil }
        let closing = " Brawo 👏"
        if situation.sentence.hasSuffix(closing) {
            return (String(closing.dropFirst()), NowSituation.noBreaks(String(situation.sentence.dropLast(closing.count))), true)
        }
        guard let end = situation.sentence.range(of: ". ") else { return nil }
        return (String(situation.sentence[..<end.lowerBound]) + ".", NowSituation.noBreaks(String(situation.sentence[end.upperBound...])), false)
    }

    /// The sentence, with "112" opening a call.
    private var mainSentence: AttributedString { attributed(situation.sentence) }

    /// Below 54 without a dose: "Podaj od razu szybkie węgle." first, the rest smaller.
    private var firstOrder: (order: String, rest: String)? {
        guard situation.state == "7b", let end = situation.sentence.range(of: ". ") else { return nil }
        return (String(situation.sentence[..<end.lowerBound]) + ".", String(situation.sentence[end.upperBound...]))
    }

    private func attributed(_ sentence: String) -> AttributedString {
        var text = AttributedString(NowSituation.noBreaks(sentence))
        if let range = text.range(of: "112") {
            text[range].link = URL(string: "tel:112")
            text[range].underlineStyle = .single
        }
        return text
    }

    // MARK: Linia dnia

    private var dayLineToken: String { "\(situation.state)|\((situation.day_lines ?? []).joined(separator: "|"))" }
    private var shownDayLine: String? {
        guard !hidesDayLine, !doubtful, staleLine == nil, !dynamicTypeSize.isAccessibilitySize,
              let dayLine, situation.day_lines?.contains(dayLine) == true else { return nil }
        return dayLine
    }

    /// With no sentence and no second sentence the day line is not an aside: it stands as the sentence itself.
    private var sentenceDayLine: String? {
        guard situation.sentence.trimmingCharacters(in: .whitespaces).isEmpty, situation.detail == nil else { return nil }
        return shownDayLine
    }

    /// The owner's calm lines (now-day-lines calm_lines): their opening words get the praise sweep, like "Pięknie.".
    private static let calmLeads = ["Nudny wykres", "Nic ciekawego."]

    private static func calmParts(_ line: String) -> (word: String, rest: String)? {
        guard let lead = calmLeads.first(where: { line.hasPrefix($0 + " ") }) else { return nil }
        return (lead, NowSituation.noBreaks(String(line.dropFirst(lead.count + 1))))
    }

    private func pickDayLine() {
        dayLine = DayLineRotation(scope: dayLineScope).line(lines: situation.day_lines ?? [], state: situation.state, now: Date())
    }

    /// One line, in its own colour with a bar, so it does not read as the second sentence. What does not fit is not shown.
    @ViewBuilder
    private var dayLineRow: some View {
        Group {
            if sentenceDayLine == nil, let line = shownDayLine {
                ViewThatFits(in: .horizontal) {
                    Text(line)
                        .font(.system(size: 15))
                        .foregroundStyle(dayLineTint(line))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) { Capsule().fill(dayLineTint(line)).frame(width: 3) }
                    Color.clear.frame(height: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 10)
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: shownDayLine)
    }

    private static let dayLineColor = Brand.dynamic(light: 0x0B6B3C, dark: 0x3CCB7F)

    /// A light fact is an extra, so it is grey; a line from the patient's own data keeps its colour (owner, 2026-11-08).
    private func dayLineTint(_ line: String) -> Color {
        line == situation.light_fact ? Color.secondary : Self.dayLineColor
    }

    // MARK: The action

    @ViewBuilder
    private var action: some View {
        if let action = situation.action, !doubtful {
            Group {
                if action.kind == "UNDO" {
                    undoButton(action)
                } else if let amount {
                    stepper(action, amount: amount)
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { actionButtons(action) }
                        VStack(spacing: 8) { actionButtons(action) }
                    }
                }
            }
            .disabled(busy)
            .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: busy)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            // The window ended on its own: read what comes next. A new situation closes the amount too.
            .task(id: action.until) {
                guard let until = action.until.flatMap(parseDate) else { return }
                try? await Task.sleep(for: .seconds(max(0, until.timeIntervalSinceNow) + 0.3))
                if !Task.isCancelled { await onUndoWindowEnd() }
            }
            .onChange(of: situation.state) { _, _ in
                self.amount = nil
                failed = nil
            }
        }
    }

    private func parseDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// `failure` says what did not happen: the caregiver must know whether the carbs were saved.
    private func perform(failure: String, _ work: @escaping () async -> Bool) {
        guard !busy, !justSwiped else { return }
        busy = true
        failed = nil
        Task {
            let succeeded = await work()
            busy = false
            failed = succeeded ? nil : failure
            if succeeded { amount = nil }
        }
    }

    private func undoButton(_ action: NowSituation.Action) -> some View {
        Button {
            guard let eventID = action.event_id else { return }
            perform(failure: "Nie udało się cofnąć zapisu węgli. Spróbuj jeszcze raz.") { await onUndo(eventID) }
        } label: {
            WorkingLabel(text: action.label, working: busy, tint: textColor)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 46)
                .overlay(Capsule().stroke(textColor.opacity(0.45), lineWidth: 1.5))
                .contentShape(Capsule())
        }
        .foregroundStyle(textColor)
        .buttonStyle(.plain)
    }

    /// − / "Podano N g" / +, 1 g at a time up to 30 g. "Zapisz węgle" starts at 0 g, with no suggested amount.
    private func stepper(_ action: NowSituation.Action, amount: Int) -> some View {
        let verb = action.kind == "GIVEN" ? "Podano" : "Zapisz"
        let lowest = action.kind == "GIVEN" ? 1 : 0
        // At 0 g there is nothing to save: an outline with dimmed words, not the filled capsule faded. A faded fill put
        // the light page colour on mid grey, unreadable in the light theme.
        let ready = amount >= 1
        return HStack(spacing: 8) {
            stepButton("minus", label: "Mniej", enabled: amount > lowest && !busy) { if !justSwiped { self.amount = amount - 1 } }
            Button {
                perform(failure: "Węgli nie zapisano. Spróbuj jeszcze raz.") { await onGiven(amount) }
            } label: {
                WorkingLabel(text: "\(verb) \(amount) g", working: busy, tint: onRed ? Self.urgentRed : DashboardPalette.pageBackground)
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .foregroundStyle(ready ? (onRed ? Self.urgentRed : DashboardPalette.pageBackground) : textColor.opacity(0.6))
                    .background {
                        if ready {
                            Capsule().fill(onRed ? Color.white : Color.primary)
                        } else {
                            Capsule().stroke(textColor.opacity(0.25), lineWidth: 1.5)
                        }
                    }
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!ready)
            stepButton("plus", label: "Więcej", enabled: amount < 30 && !busy) { if !justSwiped { self.amount = amount + 1 } }
        }
    }

    private func stepButton(_ symbol: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body.weight(.bold))
                .frame(width: 46, height: 46)
                .overlay(Circle().stroke(textColor.opacity(0.45), lineWidth: 1.5))
                .contentShape(Circle())
        }
        .foregroundStyle(textColor)
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func actionButtons(_ action: NowSituation.Action) -> some View {
        if action.kind == "GIVEN" {
            givenButton(action)
            if let other = action.other_amount_label {
                Button(other) { if !justSwiped { amount = action.grams ?? 1 } }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(textColor)
                    .padding(.horizontal, 12)
                    .fixedSize()
                    .buttonStyle(.plain)
            }
        } else {
            Button { if !justSwiped { amount = 0 } } label: {
                Text(action.label)
                    .font(.body.weight(.semibold))
                    .fixedSize()
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .overlay(Capsule().stroke(textColor.opacity(0.45), lineWidth: 1.5))
                    .contentShape(Capsule())
            }
            .foregroundStyle(textColor)
            .buttonStyle(.plain)
        }
    }

    private func givenButton(_ action: NowSituation.Action) -> some View {
        let filled = action.style == "FILLED"
        return Button {
            if let grams = action.grams { perform(failure: "Węgli nie zapisano. Spróbuj jeszcze raz.") { await onGiven(grams) } }
        } label: {
            WorkingLabel(text: action.label, working: busy, tint: filled ? (onRed ? Self.urgentRed : DashboardPalette.pageBackground) : textColor)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 46)
                .foregroundStyle(filled ? (onRed ? Self.urgentRed : DashboardPalette.pageBackground) : textColor)
                .background {
                    if filled {
                        Capsule().fill(onRed ? Color.white : Color.primary)
                    } else {
                        Capsule().stroke(textColor.opacity(0.45), lineWidth: 1.5)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// A button's words, or while its request runs a small spinner in their place: the capsule keeps its size, nothing jumps.
private struct WorkingLabel: View {
    let text: String
    let working: Bool
    let tint: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Text(text)
                .fixedSize()
                .opacity(working ? 0 : 1)
                .scaleEffect(working && !reduceMotion ? 0.9 : 1)
            if working {
                ProgressView()
                    .controlSize(.small)
                    .tint(tint)
                    .transition(.opacity.combined(with: .scale(scale: 0.6)))
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: working)
        .accessibilityLabel(working ? "Zapisuję" : text)
    }
}

/// Teraz while a saved read is too old to show: the same places as SituationBlock, so only the words arrive when the read does.
struct SituationWaiting: View {
    let pull: PullModel
    /// Shared with SituationBlock: this loader glides to become the trend circle beside the number.
    var space: Namespace.ID? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TrendBadge(direction: nil, level: .normal, activity: pull.activity, refreshing: true, dimmed: false)
                .heroMatched(id: "trend", in: space)
                .frame(maxWidth: .infinity, minHeight: 130)
            Color.clear
                .frame(height: 24)
                .padding(.top, 4)
            ShimmeringText(text: "Sprawdzam aktualny odczyt…")
                .font(.title3.weight(.semibold))
                .padding(.top, 12)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(.bottom, 8)
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .accessibilityElement(children: .combine)
    }
}

/// A waiting line in the secondary colour with a soft band of light passing through it, over and over, while the read is
/// on its way. With "Ogranicz ruch" it stands still.
private struct ShimmeringText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            Text(text).foregroundStyle(.secondary)
        } else {
            TimelineView(.animation) { context in
                // One pass in 1.6 s, then a short rest.
                let cycle = 2.1
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: cycle) / 1.6
                let center = phase * 1.6 - 0.3
                Text(text)
                    .foregroundStyle(.secondary)
                    .overlay {
                        Text(text)
                            .foregroundStyle(.primary)
                            .mask {
                                LinearGradient(
                                    stops: [
                                        .init(color: .clear, location: min(1, max(0, center - 0.18))),
                                        .init(color: .white, location: min(1, max(0, center))),
                                        .init(color: .clear, location: min(1, center + 0.18)),
                                    ],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                )
                            }
                            .accessibilityHidden(true)
                    }
            }
        }
    }
}

extension View {
    /// The same view on two screens of one place (the loader and the trend circle): it moves between them.
    @ViewBuilder
    func heroMatched(id: String, in space: Namespace.ID?) -> some View {
        if let space {
            matchedGeometryEffect(id: id, in: space)
        } else {
            self
        }
    }
}

/// The word of praise in green with one sweep of light through it, letter by letter so the sentence still wraps as one
/// text. A new sweep starts every 5 s while the sentence is on screen; with "Ogranicz ruch" just the colour.
private struct PraiseSentence: View {
    let word: String
    let rest: String
    var closing = false
    @State private var phase = 0.0
    @State private var splashGone = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        PraiseSweep(word: word, rest: rest, closing: closing, phase: phase)
            // Only once the launch splash is gone: under it nobody would see the sweep.
            .onReceive(LaunchSplashController.shared.$phase) { splash in
                if splash == .gone { splashGone = true }
            }
            .task(id: splashGone) {
                guard splashGone else { return }
                if reduceMotion { phase = 1; return }
                try? await Task.sleep(for: .milliseconds(350))
                while !Task.isCancelled {
                    // Back to the start without animating: at 0 and at 1 the word is plain green, so nothing jumps.
                    var reset = Transaction()
                    reset.disablesAnimations = true
                    withTransaction(reset) { phase = 0 }
                    withAnimation(.easeInOut(duration: 1.8)) { phase = 1 }
                    try? await Task.sleep(for: .seconds(5))
                }
            }
    }
}

private struct PraiseSweep: View, Animatable {
    let word: String
    let rest: String
    /// The word closes the sentence ("… Brawo 👏") instead of opening it.
    var closing = false
    var phase: Double
    @Environment(\.self) private var environment
    @Environment(\.colorScheme) private var colorScheme

    var animatableData: Double {
        get { phase }
        set { phase = newValue }
    }

    var body: some View {
        let letters = Array(word)
        let colored = letters.enumerated().reduce(Text("")) { text, item in
            text + Text(String(item.element)).foregroundColor(color(at: (Double(item.offset) + 0.5) / Double(max(1, letters.count))))
        }
        return closing ? Text(rest + " ") + colored : colored + Text(" " + rest)
    }

    /// Green, with a light band that crosses the word once and leaves teal behind it for a moment.
    private func color(at position: Double) -> Color {
        let band = position - (phase * 1.8 - 0.4)
        let green = DashboardPalette.green.resolve(in: environment)
        guard phase < 1 else { return Color(green) }
        let light = (colorScheme == .dark ? Color(red: 0.9, green: 1, blue: 0.94) : Color(red: 0.05, green: 0.42, blue: 0.36)).resolve(in: environment)
        let strength = Float(max(0, 1 - abs(band) / 0.28))
        return Color(red: Double(green.red + (light.red - green.red) * strength),
                     green: Double(green.green + (light.green - green.green) * strength),
                     blue: Double(green.blue + (light.blue - green.blue) * strength))
    }
}

/// A soft light from the left, in the colour of the situation, reaching a little behind the chips. It stands still once
/// it is there: when the data comes it spreads out from the left edge and fades in, and a later change only moves it to
/// the new colour. Below 54 the red background replaces it, and a stale reading has none. While the screen waits for a
/// read after a break the page is dark: the light comes with the new reading, not from the old one (owner, 2026-11-12).
struct SituationGlow: View {
    /// The glucose's tone; nil while the screen waits for a read.
    let tone: String?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 0: gone, 1: fully spread.
    @State private var bloom = 0.0
    /// Kept while it fades out, so the fading light keeps its colour.
    @State private var shownColor: Color? = nil
    @State private var splashGone = false
    @State private var started = false

    /// The pages are rebuilt after a swipe or a tab change: only the first light of a launch spreads on appearing, so a
    /// page already seen does not go dark for a moment.
    @MainActor private static var hasBloomed = false

    private static let center = UnitPoint(x: 0, y: 0.46)
    /// More than the longest pull down.
    private static let above: CGFloat = 400

    private var color: Color? { Self.color(of: tone) }

    private static func color(of tone: String?) -> Color? {
        switch tone {
        case "RED": return DashboardPalette.red
        case "AMBER": return DashboardPalette.yellow
        case "NEUTRAL": return DashboardPalette.green
        default: return nil
        }
    }

    var body: some View {
        GeometryReader { geometry in
            // Calm green is most of the day: about half as strong, so amber and red stand out when they come.
            let calm = shownColor == DashboardPalette.green
            let strength = colorScheme == .dark ? (calm ? 0.11 : 0.225) : (calm ? 0.07 : 0.15)
            // The light is laid out on its own area (from 120 above the block); the part above it only carries it on.
            let height = max(geometry.size.height - Self.above, 1)
            let center = UnitPoint(x: Self.center.x, y: (Self.above + Self.center.y * height) / geometry.size.height)
            let solidTo = (Self.above + 0.6 * height) / geometry.size.height
            RadialGradient(
                colors: [(shownColor ?? .clear).opacity(shownColor == nil ? 0 : strength), (shownColor ?? .clear).opacity(0)],
                center: center,
                startRadius: 0,
                endRadius: max(geometry.size.width, height) * 0.98
            )
            .scaleEffect(reduceMotion ? 1 : 0.45 + 0.55 * bloom, anchor: center)
            .opacity(bloom)
            // Fades out before its own lower edge, so no line shows beside the chart.
            .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: solidTo), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
        }
        // Past the screen's left edge, above the block and well below the chips, beside the chart. Far above the screen's
        // top too: pulled down to refresh, the light comes along and no dark band opens above it.
        .padding(.leading, -24)
        .padding(.trailing, -24)
        .padding(.top, -120 - Self.above)
        .padding(.bottom, -140)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { start() }
        // Only once the launch splash is gone: under it nobody would see the light spread.
        .onReceive(LaunchSplashController.shared.$phase) { phase in
            guard phase == .gone, !splashGone else { return }
            start()
            splashGone = true
            update()
        }
        .onChange(of: tone) { _, _ in update() }
    }

    /// Once per drawn page, before anything can animate: after the first light of a launch it is simply there.
    private func start() {
        guard !started else { return }
        started = true
        guard Self.hasBloomed, let initial = color else { return }
        shownColor = initial
        bloom = 1
    }

    private func update() {
        guard splashGone else { return }
        guard let color else {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.45)) { bloom = 0 }
            return
        }
        if bloom == 0 {
            Self.hasBloomed = true
            shownColor = color
            withAnimation(reduceMotion ? .easeInOut(duration: 0.5) : .timingCurve(0.3, 0.6, 0.3, 1, duration: 2)) { bloom = 1 }
        } else {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.9)) { shownColor = color }
        }
    }
}

/// A stale reading: a grey outline only, its one meaning. The outline lies under a fill in the page's colour, so the
/// digits' overlapping contours do not show.
private struct OutlinedNumber: View {
    let text: String
    let size: CGFloat

    private static let offsets: [CGSize] = (0..<16).map { index in
        let angle = Double(index) / 16 * 2 * .pi
        return CGSize(width: cos(angle) * 1.5, height: sin(angle) * 1.5)
    }

    var body: some View {
        ZStack {
            ForEach(Array(Self.offsets.enumerated()), id: \.offset) { _, offset in
                digits.foregroundStyle(Color.secondary).offset(offset)
            }
            digits.foregroundStyle(DashboardPalette.pageBackground)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ostatni odczyt \(text) mg/dL")
    }

    private var digits: some View {
        Text(text)
            .font(.system(size: size, weight: .semibold))
            .monospacedDigit()
            .tracking(-1)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
    }
}

private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

/// Offers its content the given height even inside a scroll view, and takes more only when the content cannot fit in it.
private struct FillsHeight: Layout {
    let height: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let content = subviews.first else { return .zero }
        let size = content.sizeThatFits(ProposedViewSize(width: proposal.width, height: height))
        return CGSize(width: proposal.width ?? size.width, height: max(height, size.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
                              proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// Large system text: the page scrolls, so a sentence is never cut and never runs under the title.
struct ScrollsWithLargeText: ViewModifier {
    let hasSituation: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        if hasSituation && dynamicTypeSize >= .xxLarge {
            // The cards are offered the screen's height, as without the scroll view: the chart takes the room the
            // others leave (a scroll view alone offers no height, so the chart shrank to its minimum and left empty
            // space under the tiles). Only when the cards need more than the screen does the page scroll.
            GeometryReader { geometry in
                ScrollView(.vertical, showsIndicators: false) {
                    FillsHeight(height: geometry.size.height) { content }
                }
                // The red and the glow reach past the page's margins.
                .scrollClipDisabled()
            }
        } else {
            content
        }
    }
}
