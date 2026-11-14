import SwiftUI

/// The colours of the therapy settings: one per setting, the same in every lane, tile and table header. Dark: the
/// lane colours of the app (basal as in the daily insulin card); light: the darker shade that reads as text on its tint.
enum TherapySettingsColors {
    static func color(_ key: String) -> Color {
        switch key {
        case "BASAL": return Brand.dynamic(light: 0x1F6FE5, dark: 0x9CC8FF)
        case "ICR": return Brand.dynamic(light: 0x8A5000, dark: 0xFFB547)
        case "ISF": return Brand.dynamic(light: 0x5B45D1, dark: 0xB4A7FF)
        case "TARGET": return Brand.dynamic(light: 0x12804A, dark: 0x3DD68C)
        default: return .secondary
        }
    }

    /// The segments that do not hold the marker: a tint of the colour (basal bars stronger, they carry no number).
    static func tint(_ key: String, scheme: ColorScheme) -> Color {
        let alpha: Double = key == "BASAL" ? (scheme == .dark ? 0.45 : 0.4) : (scheme == .dark ? 0.2 : 0.14)
        return color(key).opacity(alpha)
    }

    /// Text on a solid segment: black on the light dark-mode colours, white on the dark light-mode ones.
    static func onSolid(_ scheme: ColorScheme) -> Color { scheme == .dark ? .black : .white }

    static let button = Brand.dynamic(light: 0x0F766E, dark: 0x2DD4BF)
    static let stale = Brand.amber
    #if canImport(UIKit)
    static let card = Color(uiColor: .secondarySystemBackground)
    static let fill = Color(uiColor: .tertiarySystemFill)
    static let hairline = Color(uiColor: .separator)
    /// Text on a pill filled with the primary colour.
    static let onPrimary = Color(uiColor: .systemBackground)
    #else
    static let onPrimary = Color.white
    static let card = Color.secondary.opacity(0.12)
    static let fill = Color.secondary.opacity(0.12)
    static let hairline = Color.secondary.opacity(0.3)
    #endif
}

/// The card above an answer about the therapy settings (therapy-settings-card.v1,
/// docs/product/therapy-settings-cards/HANDOFF.md): one setting with its value and its day, all four as lanes, two or
/// three with one shared table, or the values at an hour. Every value, hour and sentence comes from the server; after
/// `live_until` the card is history: the hour instead of "teraz", no "teraz" tags, no loop tile.
struct TherapySettingsCardView: View {
    let therapy: ConversationMetricCard.TherapySettings
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var expanded = false
    /// The hours column of a table with several settings: wide enough for "21:30–24:00", so the values never squeeze it.
    @ScaledMetric(relativeTo: .subheadline) private var hoursWidth: CGFloat = 100

    /// A table longer than this starts collapsed, with the current row in view.
    private static let collapsedRows = 10

    init?(card: ConversationMetricCard) {
        guard card.kind == "THERAPY_SETTINGS", let therapy = card.therapy, therapy.version == "therapy-settings-card.v1" else { return nil }
        guard therapy.layout == "NO_PROFILE" ? therapy.missing != nil : !therapy.settings.isEmpty else { return nil }
        self.therapy = therapy
    }

    init(therapy: ConversationMetricCard.TherapySettings) {
        self.therapy = therapy
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            content(live: therapy.isLive(at: context.date))
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(TherapySettingsColors.card))
        }
    }

    @ViewBuilder
    private func content(live: Bool) -> some View {
        if therapy.layout == "NO_PROFILE", let missing = therapy.missing {
            VStack(alignment: .leading, spacing: 8) {
                Text(missing.title).font(.body)
                Text(missing.text).font(.subheadline).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                header(live: live)
                switch therapy.layout {
                case "SINGLE", "AT_ONE": single(live: live)
                case "AT_MANY": atMany(live: live)
                default: lanes(live: live)
                }
            }
        }
    }

    // MARK: Header

    private func header(live: Bool) -> some View {
        let single = therapy.layout == "SINGLE" || therapy.layout == "AT_ONE"
        return HStack(alignment: .center, spacing: 8) {
            HStack(spacing: 6) {
                if single, let lane = therapy.settings.first {
                    RoundedRectangle(cornerRadius: 2.5).fill(TherapySettingsColors.color(lane.key)).frame(width: 8, height: 8)
                }
                Text(live ? therapy.title : therapy.history_title)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Text(therapy.pillText)
                .font(.caption)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(therapy.stale_label != nil ? Color.black : Color.secondary)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(Capsule().fill(therapy.stale_label != nil ? TherapySettingsColors.stale : TherapySettingsColors.fill))
        }
    }

    // MARK: One setting (SINGLE, AT_ONE)

    @ViewBuilder
    private func single(live: Bool) -> some View {
        if let lane = therapy.settings.first, let current = lane.current {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(current.label)
                        .font(.system(size: 42, weight: .bold))
                        .monospacedDigit()
                    Text(lane.unit)
                        .font(.system(size: 19, weight: .semibold))
                }
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .accessibilityElement(children: .combine)
                if let sentence = therapy.sentence {
                    Text(sentence)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let stale = therapy.stale_text {
                tile(icon: "exclamationmark.circle", iconColor: TherapySettingsColors.stale, text: stale)
            } else if live, let loop = therapy.loop_now {
                tile(icon: loop.kind == "SUSPENDED" ? "pause.circle" : "arrow.triangle.2.circlepath", iconColor: TherapySettingsColors.color("BASAL"), text: loop.text)
            }
            VStack(spacing: 8) {
                DayLane(lane: lane, height: lane.key == "BASAL" ? 56 : 40, markerMinute: markerMinute, markerLabel: live ? "teraz" : therapy.at, scheme: scheme)
                    .padding(.top, 22)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(laneLabel(lane, live: live))
                axis
            }
            if therapy.layout == "AT_ONE" {
                if lane.previous != nil || lane.next != nil {
                    HStack(spacing: 10) {
                        if let previous = lane.previous { neighbourTile("Wcześniej", previous, unit: lane.unit) }
                        if let next = lane.next { neighbourTile("Później", next, unit: lane.unit) }
                    }
                }
                footer
                if lane.segments.count > 1 { expandable(live: live) }
            } else {
                if lane.segments.count > 1 { table(live: live, startsCollapsed: therapy.table.count > Self.collapsedRows) }
                footer
            }
        }
    }

    private func neighbourTile(_ title: String, _ segment: ConversationMetricCard.TherapySettings.Segment, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline).foregroundStyle(.secondary)
            Text("\(segment.label) \(unit)").font(.title3.weight(.bold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            Text("\(Self.hour(segment.start))–\(Self.hour(segment.end))").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(TherapySettingsColors.fill))
        .accessibilityElement(children: .combine)
    }

    private func tile(icon: String, iconColor: Color, text: String) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(iconColor)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(TherapySettingsColors.fill))
        .accessibilityElement(children: .combine)
    }

    // MARK: Lanes (OVERVIEW, COMBO)

    @ViewBuilder
    private func lanes(live: Bool) -> some View {
        let stacked = typeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                if !stacked { Color.clear.frame(width: Self.nameWidth, height: 1) }
                Text("Doba")
                Spacer()
                Text(live ? "Teraz \(therapy.at)" : therapy.at).monospacedDigit()
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
            ForEach(therapy.settings, id: \.key) { lane in
                laneRow(lane, live: live, stacked: stacked)
            }
            HStack(spacing: 0) {
                if !stacked { Color.clear.frame(width: Self.nameWidth, height: 1) }
                axis
                if !stacked { Color.clear.frame(width: Self.valueWidth, height: 1) }
            }
        }
        if therapy.layout == "COMBO" {
            Rectangle().fill(TherapySettingsColors.hairline).frame(height: 0.5)
            table(live: live, startsCollapsed: therapy.table.count > Self.collapsedRows)
            footer
        } else {
            footer
            expandable(live: live)
        }
    }

    private static let nameWidth: CGFloat = 66
    private static let valueWidth: CGFloat = 78

    @ViewBuilder
    private func laneRow(_ lane: ConversationMetricCard.TherapySettings.Lane, live: Bool, stacked: Bool) -> some View {
        let name = HStack(spacing: 7) {
            RoundedRectangle(cornerRadius: 2.5).fill(TherapySettingsColors.color(lane.key)).frame(width: 8, height: 8)
            Text(lane.name).font(.headline)
        }
        let value = VStack(alignment: stacked ? .leading : .trailing, spacing: 0) {
            Text(lane.current?.label ?? "").font(.title3.weight(.bold)).monospacedDigit()
            Text(lane.unit).font(.caption).foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        let dayLane = DayLane(lane: lane, height: 30, markerMinute: markerMinute, markerLabel: nil, scheme: scheme)
        Group {
            if stacked {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { name; Spacer(); value }
                    dayLane
                }
            } else {
                HStack(spacing: 0) {
                    name.frame(width: Self.nameWidth, alignment: .leading)
                    dayLane
                    value.frame(width: Self.valueWidth, alignment: .trailing)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(laneLabel(lane, live: live))
    }

    // MARK: Values at an hour (AT_MANY)

    @ViewBuilder
    private func atMany(live: Bool) -> some View {
        let columns = typeSize.isAccessibilitySize ? [GridItem(.flexible())] : [GridItem(.flexible(), spacing: 10), GridItem(.flexible())]
        LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
            ForEach(therapy.settings, id: \.key) { lane in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2.5).fill(TherapySettingsColors.color(lane.key)).frame(width: 8, height: 8)
                        Text(lane.name).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Text(lane.current?.label ?? "").font(.system(size: 30, weight: .bold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                    Text(lane.unit).font(.subheadline)
                    Text(lane.span_label).font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(TherapySettingsColors.fill))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(lane.name): \(lane.current?.label ?? "") \(lane.unit), \(lane.span_label)")
            }
        }
        expandable(live: live)
    }

    // MARK: Table

    @ViewBuilder
    private func expandable(live: Bool) -> some View {
        if expanded {
            Rectangle().fill(TherapySettingsColors.hairline).frame(height: 0.5)
            table(live: live, startsCollapsed: false)
        } else {
            showAllButton
        }
    }

    private var showAllButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) { expanded = true }
        } label: {
            Text("Pokaż wszystkie godziny")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TherapySettingsColors.button)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func table(live: Bool, startsCollapsed: Bool) -> some View {
        let rows = therapy.table
        let collapsed = startsCollapsed && !expanded
        let currentIndex = rows.firstIndex(where: \.current) ?? 0
        let first = collapsed ? max(0, min(currentIndex - 2, rows.count - 5)) : 0
        let visible = collapsed ? Array(rows[first..<min(rows.count, first + 5)]) : rows
        let multi = therapy.settings.count > 1
        VStack(spacing: 2) {
            if multi { tableHeader }
            ForEach(Array(visible.enumerated()), id: \.offset) { _, row in
                tableRow(row, live: live, multi: multi)
            }
        }
        if collapsed { showAllButton }
    }

    private var tableHeader: some View {
        HStack(alignment: .top, spacing: 6) {
            // At accessibility sizes the hours stand on their own line in each row, so no column for them here.
            if !typeSize.isAccessibilitySize {
                Text("Godziny")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: hoursWidth, alignment: .leading)
            }
            ForEach(therapy.settings, id: \.key) { lane in
                VStack(alignment: .leading, spacing: 1) {
                    Text(lane.name)
                        .foregroundStyle(TherapySettingsColors.color(lane.key))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(lane.unit)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            }
        }
        .font(.footnote)
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func tableRow(_ row: ConversationMetricCard.TherapySettings.Row, live: Bool, multi: Bool) -> some View {
        let tagged = row.current && live
        Group {
            if multi { multiRow(row) } else { singleRow(row) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(row.current ? TherapySettingsColors.fill : Color.clear))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(rowLabel(row, tagged: tagged))
    }

    /// Several settings: the hours keep their width, the values share the rest equally; at accessibility sizes the
    /// hours stand above the values. The current row is only highlighted (its background), with no "teraz" tag.
    @ViewBuilder
    private func multiRow(_ row: ConversationMetricCard.TherapySettings.Row) -> some View {
        let hours = Text("\(Self.hour(row.start))–\(Self.hour(row.end))")
            .foregroundStyle(.secondary)
            .monospacedDigit()
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                hours.lineLimit(1).minimumScaleFactor(0.7)
                HStack(alignment: .firstTextBaseline, spacing: 6) { values(row) }
            }
            .font(.subheadline)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                hours
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(width: hoursWidth, alignment: .leading)
                values(row)
            }
            .font(.subheadline)
        }
    }

    private func values(_ row: ConversationMetricCard.TherapySettings.Row) -> some View {
        ForEach(row.values, id: \.key) { value in
            Text(value.label)
                .fontWeight(value.changed ? .semibold : .regular)
                .foregroundStyle(value.changed ? Color.primary : Color.secondary)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        }
    }

    /// One setting: hours on the left, the value with its unit on the right; the current row is only highlighted.
    private func singleRow(_ row: ConversationMetricCard.TherapySettings.Row) -> some View {
        let unit = therapy.settings.first?.unit ?? ""
        return HStack(spacing: 8) {
            Text("\(Self.hour(row.start))–\(Self.hour(row.end))")
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 8)
            if let value = row.values.first {
                Text("\(value.label) \(unit)")
                    .fontWeight(.semibold)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .font(.body)
    }

    // MARK: Shared

    @ViewBuilder
    private var footer: some View {
        if let footer = therapy.footer {
            VStack(alignment: .leading, spacing: 12) {
                Rectangle().fill(TherapySettingsColors.hairline).frame(height: 0.5)
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var axis: some View {
        HStack(spacing: 0) {
            ForEach(Array(["0", "6", "12", "18", "24"].enumerated()), id: \.offset) { index, label in
                if index > 0 { Spacer(minLength: 0) }
                Text(label)
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .accessibilityHidden(true)
    }

    private var markerMinute: Int { Self.minutes(therapy.at) ?? 0 }

    /// The server's label says "teraz"; in the history form the hour instead.
    private func laneLabel(_ lane: ConversationMetricCard.TherapySettings.Lane, live: Bool) -> String {
        guard !live, therapy.is_now, let range = lane.accessibility_label.range(of: "; teraz ", options: .backwards) else { return lane.accessibility_label }
        return lane.accessibility_label.replacingCharacters(in: range, with: "; o \(therapy.at) ")
    }

    private func rowLabel(_ row: ConversationMetricCard.TherapySettings.Row, tagged: Bool) -> String {
        let values = zip(row.values, therapy.settings).map { value, lane in "\(lane.name) \(value.label) \(lane.unit)" }.joined(separator: ", ")
        return "Od \(Self.hour(row.start)) do \(Self.hour(row.end)): \(values)\(tagged ? ", teraz" : "")"
    }

    /// "00:00" → "0:00"; "24:00" stays.
    static func hour(_ stamp: String) -> String {
        stamp.hasPrefix("0") && stamp.count == 5 ? String(stamp.dropFirst()) : stamp
    }

    static func minutes(_ clock: String) -> Int? {
        let parts = clock.split(separator: ":")
        guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]) else { return nil }
        return hour * 60 + minute
    }
}

/// One setting over the day, 0–24: a block per segment (basal: bars by rate, without numbers), the segment at the
/// marker solid, the others tinted. The marker runs under the blocks, so it never crosses a number; a single card adds
/// its pill ("teraz", "13:00") above it.
private struct DayLane: View {
    let lane: ConversationMetricCard.TherapySettings.Lane
    let height: CGFloat
    let markerMinute: Int
    let markerLabel: String?
    let scheme: ColorScheme

    private static let gap: CGFloat = 2
    private static let pillHeight: CGFloat = 20
    /// A block narrower than this shows no number (30-minute segments of a Medtronic 722).
    private static let minNumberWidth: CGFloat = 24

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let maxValue = max(lane.segments.map(\.value).max() ?? 1, 0.001)
            let markerX = width * CGFloat(markerMinute) / 1440
            ZStack(alignment: .topLeading) {
                Rectangle()
                    .fill(Color.primary)
                    .frame(width: 2, height: height + 14)
                    .offset(x: markerX - 1, y: -7)
                ForEach(Array(lane.segments.enumerated()), id: \.offset) { index, segment in
                    let start = CGFloat(TherapySettingsCardView.minutes(segment.start) ?? 0)
                    let end = CGFloat(TherapySettingsCardView.minutes(segment.end) ?? 1440)
                    let x = width * start / 1440 + (index == 0 ? 0 : Self.gap / 2)
                    let blockWidth = max(1, width * (end - start) / 1440 - (index == 0 ? Self.gap / 2 : Self.gap) + (index == lane.segments.count - 1 ? Self.gap / 2 : 0))
                    let solid = index == lane.current_index
                    let blockHeight = lane.key == "BASAL" ? max(height * 0.2, height * CGFloat(segment.value / maxValue)) : height
                    RoundedRectangle(cornerRadius: height >= 40 ? 7 : 6, style: .continuous)
                        .fill(solid ? TherapySettingsColors.color(lane.key) : TherapySettingsColors.tint(lane.key, scheme: scheme))
                        .overlay {
                            if lane.key != "BASAL", width * (end - start) / 1440 >= Self.minNumberWidth {
                                Text(segment.label)
                                    .font(.system(size: height >= 40 ? 15 : 13, weight: .bold))
                                    .monospacedDigit()
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.6)
                                    .padding(.horizontal, 2)
                                    .foregroundStyle(solid ? TherapySettingsColors.onSolid(scheme) : TherapySettingsColors.color(lane.key))
                            }
                        }
                        .frame(width: blockWidth, height: blockHeight)
                        .offset(x: x, y: height - blockHeight)
                }
            }
            // An overlay does not size the lane: the pill sticks out above it without moving the blocks.
            .overlay(alignment: .topLeading) {
                if let markerLabel {
                    // A fixed size, so it can be centred on the marker and kept inside the lane without measuring.
                    let pillWidth = CGFloat(markerLabel.count) * 8.5 + 16
                    Text(markerLabel)
                        .font(.footnote.weight(.bold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(TherapySettingsColors.onPrimary)
                        .frame(width: pillWidth, height: Self.pillHeight)
                        .background(Capsule().fill(Color.primary))
                        .offset(x: min(max(markerX - pillWidth / 2, 0), max(width - pillWidth, 0)), y: -(Self.pillHeight + 7))
                }
            }
        }
        .frame(height: height)
    }
}
