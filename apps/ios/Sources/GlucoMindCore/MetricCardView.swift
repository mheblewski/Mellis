import SwiftUI

/// The time-in-range bands' colours: the tile, the breakdown and the chat's card read alike.
public enum TimeInRangeColors {
    /// AGP colours: very high orange, high yellow, in range the brand's emerald, low red, very low dark red.
    public static func color(_ kind: DashboardGlance.RangeBand.Kind) -> Color {
        switch kind {
        case .veryHigh: return Brand.dynamic(light: 0xE8590C, dark: 0xFF8A3D)
        case .high: return Color(red: 0.878, green: 0.631, blue: 0.0)
        case .inRange: return Brand.inRange
        // On the dark card very low cannot go darker than this (3:1 against the card, and it is the slice that must not
        // vanish), so low goes lighter there, to tell the two neighbours apart; towards rose, since a plain lighter red
        // comes close to very high's orange.
        case .low: return Brand.dynamic(light: 0xFF3B30, dark: 0xFF5C7A)
        case .veryLow: return Brand.dynamic(light: 0x9F1D17, dark: 0xC42E28)
        }
    }

    #if canImport(UIKit)
    static let empty = Color(uiColor: .tertiarySystemFill)
    #else
    static let empty = Color.secondary.opacity(0.12)
    #endif
}

/// The arcs of the time-in-range ring in their bands' colours, with a small gap between them. `diameter` runs through
/// the middle of the stroke. An empty track without any data.
public struct TimeInRangeRing: View {
    let arcs: [DashboardGlance.RangeArc]
    let diameter: CGFloat
    let lineWidth: CGFloat
    let gap: CGFloat

    public init(arcs: [DashboardGlance.RangeArc], diameter: CGFloat, lineWidth: CGFloat, gap: CGFloat) {
        self.arcs = arcs
        self.diameter = diameter
        self.lineWidth = lineWidth
        self.gap = gap
    }

    public var body: some View {
        let drawn = arcs.filter { !$0.isEmpty }.count
        // A single band is a whole circle, with no gap to close.
        let halfGap = drawn > 1 ? Double(gap / (.pi * diameter)) / 2 : 0
        ZStack {
            if drawn == 0 {
                Circle().stroke(TimeInRangeColors.empty, lineWidth: lineWidth)
            }
            ForEach(arcs) { arc in
                Circle()
                    .trim(from: arc.start + halfGap, to: max(arc.start + halfGap, arc.end - halfGap))
                    .stroke(TimeInRangeColors.color(arc.kind), style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
                    .opacity(arc.isEmpty ? 0 : 1)
            }
        }
        .rotationEffect(.degrees(-90))
        .frame(width: diameter, height: diameter)
    }
}

/// What the card shows, worked out from the server's numbers; nil for a card this version cannot read.
struct MetricCardContent: Equatable {
    struct Part: Equatable {
        let name: String
        let value: String
        let share: Double
        let color: Color
    }

    let value: String
    let unit: String
    let caption: String
    let parts: [Part]
    let bands: [DashboardGlance.RangeBand]?

    init?(card: ConversationMetricCard) {
        switch card.kind {
        case "TIME_IN_RANGE":
            guard let c = card.counts,
                  let bands = DashboardGlance.rangeBands(counts: [c.very_high, c.high, c.in_range, c.low, c.very_low]) else { return nil }
            let percent = { (kinds: [DashboardGlance.RangeBand.Kind]) in
                bands.filter { kinds.contains($0.kind) }.map(\.percent).reduce(0, +)
            }
            let inRange = percent([.inRange]), above = percent([.high, .veryHigh]), below = percent([.low, .veryLow])
            value = "\(inRange)"
            unit = "%"
            caption = "w zakresie · \(card.period_label)"
            // Time below range that rounds to 0% did happen.
            let belowText = below == 0 && c.low + c.very_low > 0 ? "< 1%" : "\(below)%"
            parts = [
                Part(name: "W zakresie", value: "\(inRange)%", share: Double(inRange), color: TimeInRangeColors.color(.inRange)),
                Part(name: "Powyżej", value: "\(above)%", share: Double(above), color: TimeInRangeColors.color(.high)),
                Part(name: "Poniżej", value: belowText, share: Double(below), color: TimeInRangeColors.color(.low)),
            ]
            self.bands = bands
        case "DAILY_INSULIN":
            guard let total = card.total_units, let bolus = card.bolus_units, let smb = card.smb_units, let basal = card.basal_units else { return nil }
            let units = { (value: Double) in String(format: "%.1f", value).replacingOccurrences(of: ".", with: ",") }
            value = units(total)
            unit = "j"
            caption = card.period_label
            parts = [
                Part(name: "Bolusy", value: "\(units(bolus)) j", share: bolus, color: Brand.dynamic(light: 0x0A6CFF, dark: 0x409CFF)),
                Part(name: "SMB", value: "\(units(smb)) j", share: smb, color: Brand.dynamic(light: 0x6F5BD6, dark: 0x8E7CF0)),
                Part(name: "Baza", value: "\(units(basal)) j", share: basal, color: Brand.dynamic(light: 0x8CBBFF, dark: 0xB4D4FF)),
            ]
            bands = nil
        default:
            return nil
        }
    }

    var accessibilityText: String {
        let details = parts.map { "\($0.name) \($0.value)" }.joined(separator: ", ")
        return "\(value) \(unit == "%" ? "procent" : "jednostki"), \(caption). \(details)"
    }
}

/// The one value a question asked for, its largest, above the answer's text; the parts it is made of under it.
struct MetricCardView: View {
    private let content: MetricCardContent

    init?(card: ConversationMetricCard) {
        guard let content = MetricCardContent(card: card) else { return nil }
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 16) {
                if let bands = content.bands {
                    TimeInRangeRing(arcs: DashboardGlance.rangeArcs(bands, minimumShare: 3), diameter: 64, lineWidth: 10, gap: 1.5)
                        .frame(width: 74, height: 74)
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(content.value)
                            .font(.system(size: 42, weight: .bold))
                            .monospacedDigit()
                        Text(content.unit)
                            .font(.system(size: 20, weight: .semibold))
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    Text(content.caption)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            if content.bands == nil {
                GeometryReader { geometry in
                    let total = max(content.parts.map(\.share).reduce(0, +), 0.001)
                    let visible = content.parts.filter { $0.share > 0 }
                    let room = geometry.size.width - CGFloat(max(visible.count - 1, 0)) * 2
                    HStack(spacing: 2) {
                        ForEach(visible.indices, id: \.self) { index in
                            Rectangle()
                                .fill(visible[index].color)
                                .frame(width: room * CGFloat(visible[index].share / total))
                        }
                    }
                }
                .frame(height: 10)
                .clipShape(Capsule())
            }
            HStack(alignment: .top, spacing: 8) {
                ForEach(content.parts.indices, id: \.self) { index in
                    let part = content.parts[index]
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 5) {
                            RoundedRectangle(cornerRadius: 2.5).fill(part.color).frame(width: 8, height: 8)
                            Text(part.name).font(.footnote).foregroundStyle(.secondary)
                        }
                        Text(part.value)
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(MetricCardView.background))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(content.accessibilityText)
    }

    #if canImport(UIKit)
    private static let background = Color(uiColor: .secondarySystemBackground)
    #else
    private static let background = Color.secondary.opacity(0.12)
    #endif
}
