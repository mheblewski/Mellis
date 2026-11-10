import SwiftUI

/// "Przeliczenie zmiany" above an answer (icr-whatif-card.v1, design 8.1 „Zdanie z liczbami”): one large sentence
/// carries the change of time below 70 and above 180, the gain in petrol and the cost in muted amber; a strip compares
/// the times of day replayed with the same proportion; the rest is under „Szczegóły”. The server counted everything;
/// this view only words it. Nothing here recommends the change.
struct WhatIfCardView: View {
    let card: ConversationMetricCard.WhatIf
    @State private var detailsShown = false

    init?(card: ConversationMetricCard) {
        guard card.kind == "SETTING_WHATIF", let whatif = card.whatif else { return nil }
        self.card = whatif
    }

    init(whatif: ConversationMetricCard.WhatIf, detailsShown: Bool = false) {
        self.card = whatif
        _detailsShown = State(initialValue: detailsShown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Text(WhatIfWording.sentence(card))
                .font(.system(size: 22, weight: .regular))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            if card.blocks.count >= 2 { strip }
            meta
            Divider()
            details
            Text("Zmiany ustawień omawiaj z diabetologiem.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(WhatIfColors.background))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 8) {
                Text(card.scope_label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                HStack(spacing: 3) {
                    Image(systemName: "drop.fill").font(.caption2)
                    Text("\(WhatIfWording.units(card.dose_change_u_per_meal)) j").fontWeight(.semibold).monospacedDigit()
                    Text("na posiłek")
                }
                .font(.caption)
                .foregroundStyle(WhatIfColors.insulin)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(WhatIfColors.insulin.opacity(0.12)))
                .accessibilityElement(children: .combine)
            }
            Text(card.title)
                .font(.headline)
        }
    }

    private var strip: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Według pory · czas poniżej 70 i powyżej 180")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                ForEach(card.blocks, id: \.start) { block in
                    let best = block.start == card.best_block
                    let chosen = card.blocks.count == 1 || card.scope_label.hasPrefix(block.label) || card.scope_label == "Wszystkie pory"
                    VStack(alignment: .leading, spacing: 3) {
                        Text(block.label).font(.caption.weight(.semibold))
                        Text("\(WhatIfWording.pct(block.time_below_70.now)) → \(WhatIfWording.pct(block.time_below_70.after))%")
                            .foregroundStyle(WhatIfColors.tone(of: block.time_below_70, lowerIsBetter: true).text)
                        Text("\(WhatIfWording.whole(block.time_above_180.now)) → \(WhatIfWording.whole(block.time_above_180.after))%")
                            .foregroundStyle(WhatIfColors.tone(of: block.time_above_180, lowerIsBetter: true).text)
                        if best {
                            Text("najlepszy bilans").font(.caption2.weight(.semibold)).foregroundStyle(Brand.petrol)
                        }
                    }
                    .font(.caption)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(WhatIfColors.tile))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(best ? Brand.petrol : .clear, lineWidth: 1.5))
                    .opacity(chosen || best ? 1 : 0.55)
                }
            }
        }
    }

    private var meta: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "function").font(.caption2)
            Text(WhatIfWording.meta(card))
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { detailsShown.toggle() }
            } label: {
                HStack {
                    Text("Szczegóły").font(.subheadline.weight(.medium))
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .rotationEffect(.degrees(detailsShown ? 90 : 0))
                }
                .foregroundStyle(Brand.interactive)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(detailsShown ? "Zwija szczegóły" : "Rozwija szczegóły")

            if detailsShown {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(WhatIfWording.detailRows(card), id: \.label) { row in
                        HStack(alignment: .firstTextBaseline) {
                            Text(row.label).foregroundStyle(.secondary)
                            Spacer(minLength: 8)
                            Text(row.value).fontWeight(.semibold).monospacedDigit()
                        }
                        .font(.footnote)
                    }
                    if !card.blocks.isEmpty {
                        Text("ICR po zmianie").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 4)
                        ForEach(card.blocks, id: \.start) { block in
                            HStack(alignment: .firstTextBaseline) {
                                Text("\(block.label), \(WhatIfWording.clock(block.start))–\(WhatIfWording.clock(block.end)) · \(WhatIfWording.meals(block.meals))")
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 8)
                                Text("\(WhatIfWording.number(block.icr_now)) → \(WhatIfWording.number(block.icr_after)) g/j")
                                    .fontWeight(.semibold)
                                    .monospacedDigit()
                                    .fixedSize()
                            }
                            .font(.footnote)
                        }
                    }
                    if card.meals_high_then_low > 0 {
                        Text("Obecnie w \(card.meals_high_then_low) z \(card.meals) posiłków glukoza najpierw przekracza 180, a potem spada poniżej 70. Zmiana ICR przesuwa jedną z tych stron kosztem drugiej.")
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(WhatIfColors.tile))
                    }
                    Text("Każdy posiłek z ostatnich 31 dni przeliczony z nową dawką na węgle, z ISF z ustawień i z pętlą reagującą tak, jak naprawdę reagowała. To szacunek, nie dokładny wynik.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .transition(.opacity)
            }
        }
    }
}

enum WhatIfColors {
    struct Tone { let text: Color; let fill: Color }
    static let gain = Tone(text: Brand.dynamic(light: 0x0E5A61, dark: 0x5EEAD4), fill: Brand.dynamic(light: 0xD6ECEA, dark: 0x113A3C))
    static let cost = Tone(text: Brand.dynamic(light: 0x8A5A00, dark: 0xF2C14E), fill: Brand.dynamic(light: 0xF6E8C6, dark: 0x3A2E12))
    static let neutral = Tone(text: .primary, fill: .clear)
    static let insulin = Brand.dynamic(light: 0x0A6CFF, dark: 0x409CFF)

    /// Less time below 70 or above 180 is a gain, more is a cost; a change under 0.1 point is neither.
    static func tone(of value: ConversationMetricCard.WhatIf.NowAfter, lowerIsBetter: Bool) -> Tone {
        let delta = value.after - value.now
        if abs(delta) < 0.1 { return neutral }
        return (delta < 0) == lowerIsBetter ? gain : cost
    }

    #if canImport(UIKit)
    static let background = Color(uiColor: .secondarySystemBackground)
    static let tile = Color(uiColor: .tertiarySystemBackground)
    #else
    static let background = Color.secondary.opacity(0.12)
    static let tile = Color.secondary.opacity(0.08)
    #endif
}

/// Polish wording of the card, kept apart so tests can read it.
enum WhatIfWording {
    static func pct(_ value: Double) -> String { String(format: "%.1f", value).replacingOccurrences(of: ".", with: ",") }
    static func whole(_ value: Double) -> String { "\(Int(value.rounded()))" }
    static func units(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") && text.contains(".") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        text = text.replacingOccurrences(of: ".", with: ",")
        return rounded < 0 ? text.replacingOccurrences(of: "-", with: "−") : rounded > 0 ? "+\(text)" : text
    }
    /// A plain value with a comma, no sign: 6,3 · 10 · 0,35.
    static func number(_ value: Double) -> String {
        var text = String(format: "%.2f", (value * 100).rounded() / 100)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text.replacingOccurrences(of: ".", with: ",")
    }
    static func clock(_ time: String) -> String { time.hasPrefix("0") && time.count == 5 ? String(time.dropFirst()) : time }

    /// 1 posiłek, 2–4 posiłki (not 12–14), otherwise posiłków.
    static func meals(_ count: Int) -> String { "\(count) \(plural(count, one: "posiłek", few: "posiłki", many: "posiłków"))" }
    static func nights(_ count: Int) -> String { "\(count) \(plural(count, one: "noc", few: "noce", many: "nocy"))" }
    private static func plural(_ n: Int, one: String, few: String, many: String) -> String {
        if n == 1 { return one }
        let last = n % 10, lastTwo = n % 100
        return (2...4).contains(last) && !(12...14).contains(lastTwo) ? few : many
    }

    private static func verb(_ value: ConversationMetricCard.WhatIf.NowAfter) -> String {
        value.after < value.now - 0.05 ? "spada" : value.after > value.now + 0.05 ? "rośnie" : "zostaje"
    }

    /// „Czas poniżej 70 spada z 4,5% do 1,3%, a czas powyżej 180 rośnie z 27% do 38%.” — with the two changes highlighted.
    static func sentence(_ card: ConversationMetricCard.WhatIf) -> AttributedString {
        let single = card.scope_label != "Wszystkie pory" && card.blocks.contains { card.scope_label.hasPrefix($0.label) } && !card.scope_label.contains("·")
        let lead = single ? (card.blocks.first { card.scope_label.hasPrefix($0.label) }?.label ?? "") + " czas" : "Czas"
        var text = AttributedString("\(lead) poniżej 70 \(verb(card.time_below_70)) ")
        text.foregroundColor = .secondary
        text += highlighted("z \(pct(card.time_below_70.now))% do \(pct(card.time_below_70.after))%", tone: WhatIfColors.tone(of: card.time_below_70, lowerIsBetter: true))
        var middle = AttributedString(", a czas powyżej 180 \(verb(card.time_above_180)) ")
        middle.foregroundColor = .secondary
        text += middle
        text += highlighted("z \(whole(card.time_above_180.now))% do \(whole(card.time_above_180.after))%", tone: WhatIfColors.tone(of: card.time_above_180, lowerIsBetter: true))
        var end = AttributedString(".")
        end.foregroundColor = .secondary
        text += end
        return text
    }

    private static func highlighted(_ string: String, tone: WhatIfColors.Tone) -> AttributedString {
        // No-break spaces keep a highlighted change on one line ("z 4,5% do 1,3%" never wraps after "z").
        var part = AttributedString(string.replacingOccurrences(of: " ", with: "\u{00A0}"))
        part.foregroundColor = tone.text
        part.backgroundColor = tone.fill
        part.font = .system(size: 22, weight: .semibold).monospacedDigit()
        return part
    }

    static func meta(_ card: ConversationMetricCard.WhatIf) -> String {
        "Przeliczone według ISF z ustawień, tak jak liczy pętla. Szacunek z \(card.meals) \(card.meals == 1 ? "posiłku" : "posiłków"), \(card.from_label)–\(card.to_label)\(card.small_sample ? " · mała próba" : "")."
    }

    struct Row: Hashable { let label: String; let value: String }

    static func detailRows(_ card: ConversationMetricCard.WhatIf) -> [Row] {
        var rows = [
            Row(label: "Posiłki ze spadkiem poniżej 70", value: "\(whole(card.meals_with_drop_below_70.now)) → \(whole(card.meals_with_drop_below_70.after)) z \(card.meals)"),
            Row(label: "Ponad 1 h powyżej 180", value: "\(whole(card.meals_above_180_over_1h.now)) → \(whole(card.meals_above_180_over_1h.after)) z \(card.meals)"),
        ]
        if let night = card.night {
            rows.append(Row(label: "Noce po kolacji ze spadkiem poniżej 70", value: "\(whole(night.drop_below_70.now)) → \(whole(night.drop_below_70.after)) z \(night.nights)"))
            rows.append(Row(label: "Noce z ponad 1 h powyżej 180", value: "\(whole(night.above_180_over_1h.now)) → \(whole(night.above_180_over_1h.after)) z \(night.nights)"))
        }
        rows.append(Row(label: "Średnia glukoza do 5 h po posiłku", value: "\(whole(card.mean_mgdl.now)) → \(whole(card.mean_mgdl.after)) mg/dl"))
        return rows
    }
}
