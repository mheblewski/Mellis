import Charts
import GlucoMindCore
import SwiftUI
import WidgetKit

/// One widget, three sizes (redesign 2026-10-27, artifacts/widget-redesign-mockups.html; small and medium calmed the
/// same day, artifacts/widget-calm-mockups.html): only the glucose has colour on the small and medium widgets, the
/// name and the Bolus button stay grey (Bolus only opens the Bolus tab). Small = value, change and "IOB · COB", a dot
/// by the name for equipment needing attention (only there: the other sizes say it in words); medium = the same beside a 3 h chart (two hairlines at 70/180, no
/// band, no doses) with one quiet equipment line under it when needed; large = now, a 6 h chart and three columns
/// (time in range, last bolus, equipment). An alarm (glucose < 70 or > 250, no reading for 15 min) tints the whole
/// widget red.
struct HomeWidgetView: View {
    let entry: HomeWidgetEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content.containerBackground(for: .widget) { HomeWidgetBackground(alarm: alarm) }
    }

    @ViewBuilder private var content: some View {
        switch entry.state {
        case let .data(patient, dashboard):
            let model = HomeWidgetModel(patient: patient, dashboard: dashboard, now: entry.date)
            switch family {
            case .systemMedium: MediumHomeWidget(model: model)
            case .systemLarge: LargeHomeWidget(model: model)
            default: SmallHomeWidget(model: model)
            }
        case .signedOut:
            HomeWidgetMessage(symbol: "person.crop.circle.badge.exclamationmark", text: "Zaloguj się w aplikacji Mellis")
        case .noPatient:
            HomeWidgetMessage(symbol: "person.crop.circle", text: "Brak pacjentów na tym koncie")
        case .failed:
            HomeWidgetMessage(symbol: "wifi.exclamationmark", text: "Nie udało się wczytać danych")
        }
    }

    private var alarm: Bool {
        guard case let .data(patient, dashboard) = entry.state else { return false }
        return HomeWidgetModel(patient: patient, dashboard: dashboard, now: entry.date).isAlarm
    }
}

/// Black in dark mode, as the system's own widgets (Calendar); systemBackground is grey in widgets. An alarm adds a
/// red wash fading downwards (the system drops the background in the tinted and clear modes).
private struct HomeWidgetBackground: View {
    let alarm: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            WidgetPalette.background
            if alarm {
                LinearGradient(colors: [WidgetPalette.red.opacity(colorScheme == .dark ? 0.24 : 0.13),
                                        WidgetPalette.red.opacity(colorScheme == .dark ? 0.04 : 0.02)],
                               startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.75))
            }
        }
    }
}

/// Everything the three sizes read, at the entry's moment.
struct HomeWidgetModel {
    let patient: AccessiblePatient
    let dashboard: DashboardResponse
    let now: Date

    var glucose: DashboardGlucose? { dashboard.glucose }
    var readingAge: DashboardLevel { HomeWidgetGlance.readingAge(dashboard, now: now) }
    var isOld: Bool { readingAge == .alarm }
    var minutesAgo: Int? { glucose?.observedAt.map { DashboardFormat.wholeMinutes(since: $0, now: now) } }
    var level: DashboardLevel? { glucose.map { DashboardThresholds.glucose($0.value) } }
    var equipment: [DashboardGlance.EquipmentItem] { DashboardGlance.equipment(dashboard, now: now) }
    var bolusURL: URL { HomeWidgetLink.bolus(patientID: patient.patient_id).url }
    var equipmentURL: URL { HomeWidgetLink.equipment(patientID: patient.patient_id).url }
    var patientURL: URL { URL(string: "\(AppLink.origin)/patients/\(patient.patient_id.lowercased())")! }

    /// Red wash: a fresh reading below 70 or above 250, or no reading for over 15 min.
    var isAlarm: Bool { isOld || (glucose != nil && level == .alarm) }

    /// The value's colour: range colours while fresh; grey once the reading is older than 15 min.
    var glucoseColor: Color {
        guard let level, !isOld else { return .secondary }
        return level == .normal ? Brand.inRange : WidgetPalette.levelText(level)
    }

    /// "3 min temu"; "brak odczytu od 23 min" once it is red.
    var ageText: String {
        guard let minutesAgo else { return "brak odczytu" }
        if isOld { return "brak odczytu od \(minutesAgo) min" }
        return minutesAgo == 0 ? "teraz" : "\(minutesAgo) min temu"
    }

    /// The small widget's one-line version: "brak odczytu 23 min".
    var shortOldText: String { minutesAgo.map { "brak odczytu \($0) min" } ?? "brak odczytu" }

    var ageColor: Color { readingAge == .normal ? .secondary : WidgetPalette.level(readingAge) }

    var iob: String? { dashboard.loop?.iob_units.map { "\(DashboardFormat.iob($0)) j" } }
    var cob: String? { dashboard.loop?.cob_grams.map { "\(Int($0.rounded())) g" } }
}

// MARK: - Sizes

private struct SmallHomeWidget: View {
    let model: HomeWidgetModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(model: model, bolus: .round, height: 26, quiet: true)
            // Only the glucose has colour (calm iteration): the value and its change in the middle.
            VStack(alignment: .leading, spacing: 8) {
                GlucoseHero(model: model, size: 54, circled: false)
                ChangeLine(model: model, unit: false, compact: true)
            }
            .layoutPriority(1)
            .frame(maxHeight: .infinity, alignment: .center)
            InsulinCarbsLine(model: model)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // A tap opens the patient's dashboard; only the round button opens the Bolus tab.
        .widgetURL(model.patientURL)
    }
}

private struct MediumHomeWidget: View {
    let model: HomeWidgetModel

    var body: some View {
        let attention = DashboardGlance.attention(model.equipment).first
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 0) {
                // No dot here: the equipment line under the chart already says it.
                PatientName(name: model.patient.display_name, quiet: true)
                    .frame(height: 26)
                VStack(alignment: .leading, spacing: 8) {
                    GlucoseHero(model: model, size: 52, circled: false)
                    ChangeLine(model: model, unit: false, compact: true)
                }
                .frame(maxHeight: .infinity, alignment: .center)
                InsulinCarbsLine(model: model)
            }
            .frame(width: 146, alignment: .leading)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Spacer(minLength: 0)
                    BolusLink(url: model.bolusURL, style: .round)
                }
                .frame(height: 26)
                GlucoseChart(model: model, hours: 3, style: .medium)
                    .frame(maxHeight: .infinity)
                if let attention {
                    Link(destination: model.equipmentURL) { QuietEquipmentLine(item: attention) }
                }
            }
        }
        .widgetURL(model.patientURL)
    }
}

private struct LargeHomeWidget: View {
    let model: HomeWidgetModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Header(model: model, bolus: .labelled, showsLoop: true)
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 6) {
                    GlucoseHero(model: model, size: 56, circled: true)
                    ChangeLine(model: model, unit: true, compact: false)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 6) {
                    if let iob = model.iob { StackedMetric(key: "IOB", value: iob, color: WidgetPalette.insulinText, trailing: true) }
                    if let cob = model.cob { StackedMetric(key: "COB", value: cob, color: WidgetPalette.carbsText, trailing: true) }
                }
            }
            .padding(.top, 8)
            GlucoseChart(model: model, hours: 6, style: .large)
                .frame(maxHeight: .infinity)
                .padding(.top, 12)
                .padding(.bottom, 10)
            LargeFooter(model: model)
        }
        .widgetURL(model.patientURL)
    }
}

/// Three columns under hairlines: time in range (with the five bands), the last bolus, the equipment item that needs
/// attention most (else the sensor).
private struct LargeFooter: View {
    let model: HomeWidgetModel

    var body: some View {
        VStack(spacing: 0) {
            Hairline()
            HStack(alignment: .top, spacing: 0) {
                timeInRange.frame(maxWidth: .infinity, alignment: .leading)
                VerticalHairline()
                lastBolus.padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading)
                VerticalHairline()
                Link(destination: model.equipmentURL) { equipment }
                    .padding(.leading, 10).frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 10)
        }
    }

    private var timeInRange: some View {
        let tir = model.dashboard.time_in_range
        let bands = DashboardGlance.rangeBands(model.dashboard.readings, hours: tir?.hours ?? 24, now: model.now)
        let percent = bands?.first { $0.kind == .inRange }?.percent ?? tir?.in_range_percent
        let level = percent.map { DashboardThresholds.timeInRange(percent: $0) } ?? .normal
        return FooterColumn(title: "W zakresie · \(tir?.hours ?? 24) h",
                            value: percent.map { "\($0)%" } ?? "brak danych",
                            valueColor: percent == nil ? .secondary : (level == .normal ? Brand.inRange : WidgetPalette.levelText(level))) {
            if let bands { RangeBandsBar(bands: bands) }
        }
    }

    private var lastBolus: some View {
        let bolus = DashboardGlance.lastBolus(model.dashboard)
        return FooterColumn(title: "Ostatni bolus",
                            value: bolus.map { "\(DashboardFormat.dose($0.units)) j" } ?? "brak w 24 h",
                            valueColor: bolus == nil ? .secondary : WidgetPalette.insulinText) {
            if let bolus {
                Text(RemoteCommandFormat.time(bolus.at)).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }

    @ViewBuilder private var equipment: some View {
        if let item = HomeWidgetGlance.equipmentTiles(model.equipment).first {
            let color = item.level == .normal ? Brand.inRange : WidgetPalette.level(item.level)
            FooterColumn(title: item.hint.map { "\(item.name) · \($0)" } ?? item.name, value: item.value,
                         valueColor: item.level == .normal ? .primary : WidgetPalette.levelText(item.level)) {
                if let fraction = item.fraction { Meter(fraction: fraction, color: color) }
            }
        } else {
            FooterColumn(title: "Sprzęt", value: "brak danych", valueColor: .secondary) { EmptyView() }
        }
    }
}

// MARK: - Parts

/// The patient's name (with the loop's age on the large widget) and the Bolus button.
private struct Header: View {
    let model: HomeWidgetModel
    let bolus: BolusLink.Style
    var showsLoop = false
    var height: CGFloat = 28
    /// Grey name with a dot for equipment needing attention (small widget); the brand name otherwise.
    var quiet = false

    var body: some View {
        HStack(spacing: 6) {
            PatientName(name: model.patient.display_name, quiet: quiet,
                        dueLevel: quiet ? DashboardGlance.attention(model.equipment).first?.level : nil)
            if showsLoop, let loop = DashboardGlance.loop(model.dashboard, now: model.now) {
                LoopLine(loop: loop)
            }
            Spacer(minLength: 4)
            BolusLink(url: model.bolusURL, style: bolus)
        }
        .frame(height: height)
    }
}

private struct PatientName: View {
    let name: String
    var quiet = false
    /// A dot after the name when equipment needs attention (yellow soon, red now).
    var dueLevel: DashboardLevel?

    var body: some View {
        HStack(spacing: 6) {
            Text(name)
                .font(.system(size: 13, weight: quiet ? .medium : .semibold))
                .foregroundStyle(quiet ? AnyShapeStyle(.secondary) : AnyShapeStyle(Brand.petrol))
                .lineLimit(1)
            if let dueLevel, dueLevel != .normal {
                Circle().fill(WidgetPalette.level(dueLevel)).frame(width: 7, height: 7)
                    .accessibilityLabel(dueLevel == .alarm ? "Sprzęt do wymiany teraz" : "Sprzęt do wymiany wkrótce")
            }
        }
    }
}

/// "IOB 1,35 j · COB 22 g": one quiet line, the values in their colours.
private struct InsulinCarbsLine: View {
    let model: HomeWidgetModel

    var body: some View {
        HStack(spacing: 5) {
            if let iob = model.iob { InlineMetric(key: "IOB", value: iob, color: WidgetPalette.insulinText) }
            if model.iob != nil, model.cob != nil { Text("·").font(.system(size: 12)).foregroundStyle(.secondary) }
            if let cob = model.cob { InlineMetric(key: "COB", value: cob, color: WidgetPalette.carbsText) }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.85)
    }
}

/// The medium widget's equipment line under the chart, only when something needs attention: a coloured triangle,
/// grey words ("⚠ Zbiornik 22 j · wymień dziś"), so it never competes with the glucose.
private struct QuietEquipmentLine: View {
    let item: DashboardGlance.EquipmentItem

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(WidgetPalette.level(item.level))
            Text([item.headline, item.hint].compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }
}

/// The one control of every size: it only opens the Bolus tab (a Link of its own; taps elsewhere open the dashboard
/// through widgetURL, which also works in the small widget).
private struct BolusLink: View {
    enum Style { case round, labelled }
    let url: URL
    let style: Style

    var body: some View {
        Link(destination: url) {
            switch style {
            case .round:
                // Quiet grey: only the glucose has colour on the small and medium widgets.
                // The outline syringe, smaller in its circle (the filled one looked heavy).
                Image(systemName: "syringe")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.primary)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(Color.primary.opacity(0.12)))
            case .labelled:
                Label("Bolus", systemImage: "syringe")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 11)
                    .frame(height: 28)
                    .background(Capsule().fill(Brand.interactive))
            }
        }
        .widgetAccentable()
        .accessibilityLabel("Bolus")
        .accessibilityHint("Otwiera zakładkę Bolus")
    }
}

/// The value with its trend arrow: bare next to the digits on the small widget (its only circle is the Bolus button),
/// in a translucent circle tinted by the level on the medium and large ones, as on the dashboard.
private struct GlucoseHero: View {
    let model: HomeWidgetModel
    let size: CGFloat
    let circled: Bool

    var body: some View {
        HStack(alignment: .center, spacing: circled ? 7 : 4) {
            Text(model.glucose.map { "\($0.value)" } ?? "—")
                .font(.system(size: size, weight: .bold, design: .rounded))
                .tracking(-1)
                .monospacedDigit()
                .foregroundStyle(model.glucoseColor)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .widgetAccentable()
            if !model.isOld, let symbol = WidgetTrend.symbol(model.glucose?.direction) {
                let arrows = TrendArrows(symbol: symbol, double: WidgetTrend.isDouble(model.glucose?.direction),
                                         size: circled ? size * 0.4 : size * 0.52, color: model.glucoseColor)
                if circled {
                    arrows
                        .frame(width: size * 0.72, height: size * 0.72)
                        .background(Circle().fill(model.glucoseColor.opacity(0.17)))
                } else {
                    arrows
                }
            }
        }
        // The rounded font's line box is ~1.2× its size; trim it so the digits sit as tight as on the mockup.
        .padding(.vertical, -size * 0.1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(model.glucose.map { "Glukoza \($0.value) mg/dL, \(model.ageText)" } ?? "Brak odczytu")
    }
}

private struct TrendArrows: View {
    let symbol: String
    let double: Bool
    let size: CGFloat
    let color: Color

    var body: some View {
        HStack(spacing: -size * 0.35) {
            ForEach(0..<(double ? 2 : 1), id: \.self) { _ in
                Image(systemName: symbol)
            }
        }
        .font(.system(size: size, weight: .bold))
        .foregroundStyle(color)
    }
}

/// "+4 · 3 min temu" (the change per 5 min, bold; red with a red value); once the reading is old, a red "brak
/// odczytu" in its place: the small widget's short form keeps it on one line.
private struct ChangeLine: View {
    let model: HomeWidgetModel
    let unit: Bool
    let compact: Bool

    var body: some View {
        Group {
            if model.isOld {
                Text(compact ? model.shortOldText : model.ageText)
                    .fontWeight(.semibold)
                    .foregroundStyle(WidgetPalette.levelText(.alarm))
                    .lineLimit(compact ? 1 : 2)
            } else if let delta = model.glucose?.delta {
                Text(DashboardFormat.signedDelta(delta))
                    .fontWeight(.semibold)
                    .foregroundStyle(model.level == .alarm ? WidgetPalette.levelText(.alarm) : Color.primary)
                + Text("\(unit ? " mg/dL" : "") · \(model.ageText)").foregroundStyle(model.ageColor)
            } else {
                Text(model.glucose == nil ? model.ageText : "\(unit ? "mg/dL · " : "")\(model.ageText)")
                    .foregroundStyle(model.ageColor)
            }
        }
        .font(.system(size: 12))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

/// "IOB 1,35 j" on one line (small widget).
private struct InlineMetric: View {
    let key: String
    let value: String
    let color: Color

    var body: some View {
        (Text("\(key) ").foregroundStyle(.secondary).fontWeight(.medium) + Text(value).foregroundStyle(color).fontWeight(.semibold))
            .font(.system(size: 12))
            .monospacedDigit()
            .fixedSize()
    }
}

/// A small caps label over the value (medium and large widgets).
private struct StackedMetric: View {
    let key: String
    let value: String
    let color: Color
    var trailing = false

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 1) {
            Text(key).font(.system(size: 10, weight: .semibold)).tracking(0.4).foregroundStyle(.secondary)
            Text(value).font(.system(size: 14, weight: .semibold)).monospacedDigit().foregroundStyle(color).lineLimit(1)
        }
    }
}

private struct LoopLine: View {
    let loop: DashboardGlance.LoopStatus

    var body: some View {
        let color = loop.level == .normal ? Brand.inRange : WidgetPalette.level(loop.level)
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(loop.level == .normal ? "Pętla · \(DashboardGlance.ago(minutes: loop.minutes))" : "Pętla \(loop.minutes) min")
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(loop.level == .normal ? Color.secondary : WidgetPalette.levelText(loop.level))
        .lineLimit(1)
    }
}

private struct FooterColumn<Detail: View>: View {
    let title: String
    let value: String
    let valueColor: Color
    @ViewBuilder let detail: Detail

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
            Text(value).font(.system(size: 17, weight: .semibold)).monospacedDigit().foregroundStyle(valueColor)
                .lineLimit(1).minimumScaleFactor(0.7)
            detail.padding(.top, 2)
        }
    }
}

/// The five bands side by side, very low on the left (as the dashboard's breakdown, read left to right).
private struct RangeBandsBar: View {
    let bands: [DashboardGlance.RangeBand]

    var body: some View {
        GeometryReader { geometry in
            let shown = bands.sorted { $0.kind.rawValue > $1.kind.rawValue }.filter { $0.percent > 0 }
            let gaps = CGFloat(max(shown.count - 1, 0))
            HStack(spacing: 1) {
                ForEach(shown) { band in
                    Rectangle().fill(color(band.kind))
                        .frame(width: max(2, (geometry.size.width - gaps) * CGFloat(band.percent) / 100))
                }
            }
            .frame(width: geometry.size.width, alignment: .leading)
            .clipShape(Capsule())
        }
        .frame(height: 4)
        .padding(.top, 4)
    }

    private func color(_ kind: DashboardGlance.RangeBand.Kind) -> Color {
        switch kind {
        case .veryLow: return WidgetPalette.red
        case .low: return WidgetPalette.red.opacity(0.55)
        case .inRange: return Brand.inRange
        case .high: return WidgetPalette.yellow
        case .veryHigh: return Color(red: 0.89, green: 0.42, blue: 0.10)
        }
    }
}

private struct Meter: View {
    let fraction: Double
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.18))
                Capsule().fill(color).frame(width: geometry.size.width * (fraction.isFinite ? min(max(fraction, 0.04), 1) : 0))
            }
        }
        .frame(height: 4)
        .padding(.top, 4)
    }
}

private struct Hairline: View {
    var body: some View { Rectangle().fill(Color.secondary.opacity(0.22)).frame(height: 0.5) }
}

private struct VerticalHairline: View {
    var body: some View { Rectangle().fill(Color.secondary.opacity(0.22)).frame(width: 0.5).frame(maxHeight: .infinity) }
}

/// Readings as dots in range colours. The newest reading is a bigger dot in its own range colour with a ring and a
/// soft halo; an old one is a hollow grey dot with a dotted line to now. Medium: two hairlines at 70/180 only. Large:
/// the 70–180 band, boluses (blue) and SMBs (purple) in a strip under the readings with dose labels, and the hours.
private struct GlucoseChart: View {
    enum Style { case medium, large }
    let model: HomeWidgetModel
    let hours: Double
    let style: Style

    var body: some View {
        let points = HomeWidgetGlance.points(model.dashboard, hours: hours, now: model.now)
        let from = model.now.addingTimeInterval(-hours * 3_600)
        let floor = 40.0
        let doseHeight = 12.0
        let domain: ClosedRange<Double> = (style == .medium ? floor : floor - doseHeight)...HomeWidgetGlance.scaleTop(points)
        let bandLow = max(70, domain.lowerBound), bandHigh = min(180, domain.upperBound)
        let last = points.last
        let dot: CGFloat = style == .large ? 8 : 9
        Chart {
            if style != .medium, bandHigh > bandLow {
                RectangleMark(xStart: .value("od", from), xEnd: .value("do", model.now),
                              yStart: .value("min", bandLow), yEnd: .value("max", bandHigh))
                    .foregroundStyle(Brand.inRange.opacity(0.09))
            }
            ForEach([70.0, 180.0], id: \.self) { value in
                RuleMark(y: .value("granica", value))
                    .lineStyle(StrokeStyle(lineWidth: style == .medium ? 1 : 0.5, dash: style == .medium ? [] : [2, 3]))
                    .foregroundStyle(Color.secondary.opacity(style == .medium ? 0.22 : 0.45))
            }
            ForEach(Array(points.dropLast().enumerated()), id: \.offset) { _, point in
                PointMark(x: .value("czas", point.at), y: .value("mg/dL", point.value))
                    .symbolSize(dot)
                    .foregroundStyle(WidgetPalette.glucose(DashboardThresholds.glucose(point.value)).opacity(model.isOld ? 0.45 : 1))
            }
            if let last {
                if model.isOld {
                    RuleMark(xStart: .value("od", last.at), xEnd: .value("do", model.now), y: .value("mg/dL", last.value))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [1.5, 3]))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                    // Stacked plain marks: custom symbol views crash the extension when WidgetKit archives the view.
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(70).foregroundStyle(Color.secondary)
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(30).foregroundStyle(WidgetPalette.background)
                } else {
                    let color = WidgetPalette.glucose(DashboardThresholds.glucose(last.value))
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(200).foregroundStyle(color.opacity(0.18))
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(80).foregroundStyle(WidgetPalette.background)
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(42).foregroundStyle(color)
                }
            }
            // Doses only on the large widget (the medium stays calm).
            if style == .large {
                ForEach(Array(HomeWidgetGlance.boluses(model.dashboard, hours: hours, now: model.now).enumerated()), id: \.offset) { _, dose in
                    BarMark(x: .value("czas", dose.at), yStart: .value("od", floor - doseHeight), yEnd: .value("do", floor - 2), width: 3)
                        .foregroundStyle(WidgetPalette.insulinText)
                        .clipShape(Capsule())
                        .annotation(position: .trailing, spacing: 2) {
                            if style == .large {
                                Text(DashboardFormat.dose(dose.units)).font(.system(size: 9, weight: .bold)).foregroundStyle(WidgetPalette.insulinText)
                            }
                        }
                }
                ForEach(Array(HomeWidgetGlance.smbs(model.dashboard, hours: hours, now: model.now).enumerated()), id: \.offset) { _, dose in
                    PointMark(x: .value("czas", dose.at), y: .value("mg/dL", floor - doseHeight + 2))
                        .symbolSize(6)
                        .foregroundStyle(WidgetPalette.smb)
                }
            }
        }
        .chartXScale(domain: from...model.now)
        .chartYScale(domain: domain)
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: 2)) { value in
                AxisValueLabel(collisionResolution: .disabled) {
                    if let date = value.as(Date.self) {
                        Text(Self.hour.string(from: date)).font(.system(size: 10)).foregroundStyle(Color.secondary).fixedSize()
                    }
                }
            }
        }
        .chartXAxis(style == .large ? .visible : .hidden)
        .chartYAxis {
            AxisMarks(position: .trailing, values: [70, 180]) { _ in
                AxisValueLabel().font(.system(size: 9)).foregroundStyle(Color.secondary.opacity(0.7))
            }
        }
        .chartYAxis(style == .large ? .visible : .hidden)
        .chartLegend(.hidden)
    }

    private static let hour: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
}

private struct HomeWidgetMessage: View {
    let symbol: String
    let text: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.title2).foregroundStyle(Brand.petrol)
            Text(text).font(.footnote.weight(.medium)).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Style

/// The dashboard's colours (DashboardPalette lives in the app target).
enum WidgetPalette {
    static let background = Brand.dynamic(light: 0xFFFFFF, dark: 0x000000)
    static let yellow = Color(red: 0.878, green: 0.631, blue: 0.0)
    static let red = Color(red: 1.0, green: 0.231, blue: 0.188)
    static let insulin = Color(red: 0.039, green: 0.424, blue: 1.0)
    static let smb = Color(red: 0.498, green: 0.467, blue: 0.867)
    /// Text and thin marks: darker yellow and red on white, lighter on black, so small type stays legible.
    static let yellowText = Brand.dynamic(light: 0xC98F00, dark: 0xFFC53D)
    static let redText = Brand.dynamic(light: 0xE5302A, dark: 0xFF5A4F)
    static let insulinText = Brand.dynamic(light: 0x0A6CFF, dark: 0x5EA1FF)
    static let carbsText = Brand.dynamic(light: 0x9A620C, dark: 0xFAC775)

    static func level(_ level: DashboardLevel) -> Color {
        switch level {
        case .normal: return .primary
        case .warning: return yellow
        case .alarm: return red
        }
    }

    static func levelText(_ level: DashboardLevel) -> Color {
        switch level {
        case .normal: return .primary
        case .warning: return yellowText
        case .alarm: return redText
        }
    }

    static func glucose(_ level: DashboardLevel) -> Color {
        level == .normal ? Brand.inRange : self.level(level)
    }
}

/// Nightscout's direction as an SF Symbol, the double ones drawn twice (as the dashboard's TrendArrow).
enum WidgetTrend {
    static func isDouble(_ direction: String?) -> Bool {
        direction == "DoubleUp" || direction == "DoubleDown"
    }

    static func symbol(_ direction: String?) -> String? {
        switch direction {
        case "Flat": "arrow.right"
        case "FortyFiveUp": "arrow.up.right"
        case "SingleUp": "arrow.up"
        case "DoubleUp": "arrow.up"
        case "FortyFiveDown": "arrow.down.right"
        case "SingleDown": "arrow.down"
        case "DoubleDown": "arrow.down"
        default: nil
        }
    }
}
