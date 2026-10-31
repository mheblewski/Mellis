import ActivityKit
import Charts
import GlucoMindCore
import SwiftUI
import WidgetKit

/// The glucose Live Activity (redesign 2026-10-27, artifacts/live-activity-redesign.html), in the home widgets'
/// language: the value leads with a bare trend arrow, a 2 h sparkline instead of chips, IOB/COB quiet, equipment only
/// when it needs attention (a triangle and its name, no "!"). Lock screen (and StandBy, which scales it): name, value,
/// change and the reading's age ticking by itself ("3 minuty temu"), the sparkline with IOB/COB under it. Island:
/// compact = value | IOB, minimal = value, expanded = a small dashboard with a 2 h chart and Bolus. Watch Smart Stack
/// and CarPlay: a small layout of its own (the widget extension needs iOS 18 for it). The system's glass stays
/// untinted, alarms included (owner). A stale reading (none for 15 min, or the push's stale date) has the home widgets'
/// look (StaleReading, stale-ui.v1): the value and arrow dimmed in place, the age ticking on in red.
/// Two patients (2026-10-29, migration 094): the lock screen shows both side by side (name in the patient's colour,
/// value with the trend, change and age; no chart); the island shows "Oboje" (one value each side, no IOB) or
/// "Bliższe zagrożeniu" (that patient's value and IOB, LiveDanger), minimal = the patient closer to danger, expanded =
/// both patients' columns.
struct GlucoseLiveActivity: Widget {
    var body: some WidgetConfiguration {
        configuration.supplementalActivityFamilies([.small])
    }

    private var configuration: some WidgetConfiguration {
        ActivityConfiguration(for: GlucoseActivityAttributes.self) { context in
            let pair = LivePair(context: context)
            if let pair {
                TwoPatientLockScreen(pair: pair)
                    .widgetURL(pair.first.patientURL)
            } else {
                let model = LiveGlucoseModel(context: context)
                LockScreenGlucose(model: model)
                    .widgetURL(model.patientURL)
            }
        } dynamicIsland: { context in
            let model = LiveGlucoseModel(context: context)
            let pair = LivePair(context: context)
            // "Dynamic Island" in Settings picks the compact island: "Glukoza i IOB" (value | IOB) or "Sama glukoza"
            // (value, trailing empty). iOS always shows a running activity in the island, so it is never empty.
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    if let pair {
                        LivePatientColumn(model: pair.expandedFirst, alignment: .leading)
                            .padding(.leading, 6)
                    } else {
                        VStack(alignment: .leading, spacing: 2) {
                            LiveName(name: model.patientName, size: 13)
                            LiveHero(model: model, size: 34)
                        }
                        .padding(.leading, 6)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let pair {
                        LivePatientColumn(model: pair.expandedSecond, alignment: .trailing)
                            .padding(.trailing, 6)
                    } else {
                        VStack(alignment: .trailing, spacing: 3) {
                            LiveAgeLine(model: model)
                            LiveMetric(key: "IOB", value: model.iob, color: WidgetPalette.insulinText).padding(.top, 3)
                            LiveMetric(key: "COB", value: model.cob, color: WidgetPalette.carbsText)
                        }
                        .padding(.trailing, 6)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if pair == nil {
                        // The expanded island is at most 160 pt tall: chart and buttons must fit under the value.
                        VStack(spacing: 6) {
                            Color.clear
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                                .overlay { LiveChart(model: model, style: .expanded) }
                            HStack(spacing: 8) {
                                Link(destination: model.equipmentURL) { LiveEquipmentPill(item: model.dueEquipment) }
                                Spacer(minLength: 0)
                                Link(destination: model.bolusURL) {
                                    Label("Bolus", systemImage: "syringe.fill")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 13)
                                        .frame(height: 28)
                                        .background(Capsule().fill(Brand.interactive))
                                }
                                .accessibilityHint("Otwiera zakładkę Bolus")
                            }
                        }
                        .padding(.horizontal, 6)
                    }
                }
            } compactLeading: {
                if let pair {
                    switch pair.mode {
                    case .both: LiveHero(model: pair.left, size: 16)
                    case .closer: LiveInitialHero(model: pair.closer)
                    }
                } else {
                    LiveHero(model: model, size: 16)
                }
            } compactTrailing: {
                if let pair {
                    switch pair.mode {
                    case .both: LiveHero(model: pair.right, size: 16)
                    case .closer:
                        if let iob = pair.closer.iob {
                            Text(iob).font(.system(size: 14, weight: .semibold)).monospacedDigit().foregroundStyle(WidgetPalette.insulinText)
                        }
                    }
                } else if model.state.islandShowsIOB, let iob = model.iob {
                    Text(iob).font(.system(size: 14, weight: .semibold)).monospacedDigit().foregroundStyle(WidgetPalette.insulinText)
                }
            } minimal: {
                // Shared with another app's activity: the patient closer to danger (with two).
                let shown = pair?.closer ?? model
                Text(shown.valueText)
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(shown.valueColor)
                    .minimumScaleFactor(0.6)
                    .staleDimmed(shown.isDimmed)
            }
            .widgetURL(pair?.closer.patientURL ?? model.patientURL)
            .keylineTint(pair?.closer.keylineColor ?? model.keylineColor)
        }
    }
}

// MARK: - Two patients

/// Both patients of a two-patient activity, as the layouts use them: the caregiver's order, the island's sides and
/// the patient closer to danger (LiveDanger, Core). nil with one patient.
struct LivePair {
    let first: LiveGlucoseModel
    let second: LiveGlucoseModel
    let left: LiveGlucoseModel
    let right: LiveGlucoseModel
    let closer: LiveGlucoseModel
    let mode: LiveIslandMode

    init?(state: GlucoseActivityState, attributesID: String, attributesName: String, isStale: Bool, now: Date = Date()) {
        let glances = state.patients(attributesID: attributesID, attributesName: attributesName)
        guard glances.count > 1, let sides = LiveIslandSides.assign(glances, left: state.islandLeft), let right = sides.right,
              let closer = LiveDanger.closer(glances, now: now) else { return nil }
        let model = { (glance: LivePatientGlance) in LiveGlucoseModel(glance: glance, isStale: isStale) }
        first = model(glances[0])
        second = model(glances[1])
        left = model(sides.left)
        self.right = model(right)
        self.closer = model(closer)
        mode = state.mode
    }

    init?(context: ActivityViewContext<GlucoseActivityAttributes>) {
        self.init(state: context.state, attributesID: context.attributes.patientID, attributesName: context.attributes.patientName, isStale: context.isStale)
    }

    /// The expanded island: "Oboje" keeps the sides; "Bliższe zagrożeniu" puts that patient first.
    var expandedFirst: LiveGlucoseModel { mode == .closer ? closer : left }
    var expandedSecond: LiveGlucoseModel {
        guard mode == .closer else { return right }
        return closer.patientID == first.patientID ? second : first
    }
}

/// Lock screen with two patients: side by side, each with the name in their colour, the value with the trend and
/// "+4 · 3 min temu" (greyed once old, as with one patient). Two fixed halves, no ForEach (WidgetKit archives the view).
private struct TwoPatientLockScreen: View {
    let pair: LivePair

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Link(destination: pair.first.patientURL) {
                LivePatientHalf(model: pair.first)
            }
            Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 0.5)
                .padding(.vertical, 4)
                .padding(.horizontal, 14)
            Link(destination: pair.second.patientURL) {
                LivePatientHalf(model: pair.second)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

private struct LivePatientHalf: View {
    let model: LiveGlucoseModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LiveName(name: model.patientName, size: 13, color: model.nameColor)
            LiveHero(model: model, size: 40)
                .padding(.top, 4)
            // Never inside .fixedSize(): with the self-updating age the whole activity drew nothing (2026-10-27).
            LiveAgeLine(model: model)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The expanded island's column for one of two patients: name, value, age, IOB.
private struct LivePatientColumn: View {
    let model: LiveGlucoseModel
    let alignment: HorizontalAlignment

    var body: some View {
        VStack(alignment: alignment, spacing: 2) {
            LiveName(name: model.patientName, size: 13, color: model.nameColor)
            LiveHero(model: model, size: 30)
            LiveAgeLine(model: model)
            LiveMetric(key: "IOB", value: model.iob, color: WidgetPalette.insulinText, size: 12)
                .padding(.top, 2)
        }
    }
}

/// "Bliższe zagrożeniu", compact leading: the patient's initial in their colour, then the value (which patient it is
/// must be clear when it changes).
private struct LiveInitialHero: View {
    let model: LiveGlucoseModel

    var body: some View {
        HStack(spacing: 4) {
            Text(String(model.patientName.prefix(1)).uppercased())
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(model.nameColor)
            LiveHero(model: model, size: 16)
        }
    }
}

// MARK: - Model

/// What the activity shows, from the pushed content and the dashboard's thresholds.
struct LiveGlucoseModel {
    let patientID: String
    let patientName: String
    let state: GlucoseActivityState
    let isStale: Bool

    init(patientID: String, patientName: String, state: GlucoseActivityState, isStale: Bool) {
        self.patientID = patientID
        self.patientName = patientName
        self.state = state
        self.isStale = isStale
    }

    init(context: ActivityViewContext<GlucoseActivityAttributes>) {
        // The state names the patient when the server sent it (two-patient activities: the first one may change).
        self.init(patientID: context.state.patientID ?? context.attributes.patientID,
                  patientName: context.state.patientName ?? context.attributes.patientName,
                  state: context.state, isStale: context.isStale)
    }

    /// One of two patients (no chart, no equipment: the two-patient layouts show neither).
    init(glance: LivePatientGlance, isStale: Bool) {
        self.init(
            patientID: glance.id, patientName: glance.name,
            state: GlucoseActivityState(glucose: glance.glucose, direction: glance.direction, delta: glance.delta, readingAt: glance.readingAt,
                                        iob: glance.iob, cob: nil, reservoir: nil, reservoirFull: nil, battery: nil, siteChangedAt: nil,
                                        sensorStartedAt: nil, readings: [], boluses: []),
            isStale: isStale
        )
    }

    /// The patient's own colour (PatientColor, the same as their avatar in Settings).
    var nameColor: Color { PatientColor.forPatient(id: patientID).text }

    /// Stale (no reading for over 15 min as on the widgets, StaleReading, or the push's stale date). Evaluated only on a
    /// redraw: the server sends one update when the reading turns stale (the stale nudge) so this dims on time.
    var isOld: Bool {
        isStale || StaleReading.isStale(observedAt: state.readingDate, now: Date())
    }

    /// A value to dim: stale with a value ("—" stays as it is).
    var isDimmed: Bool { isOld && state.glucose != nil }

    var level: DashboardLevel? { state.glucose.map(DashboardThresholds.glucose) }
    var valueText: String { state.glucose.map(String.init) ?? "—" }

    /// The range colour; a stale value keeps it under the shared dimming (StaleReading).
    var valueColor: Color {
        guard let level else { return .secondary }
        return level == .normal ? Brand.inRange : WidgetPalette.levelText(level)
    }

    /// The island's outline: grey once stale (a dimmed value has no alarm colour to show).
    var keylineColor: Color { isOld ? .secondary : valueColor }

    /// The arrow stays when stale, dimmed with the value.
    var trendSymbol: String? { WidgetTrend.symbol(state.direction) }
    var trendIsDouble: Bool { WidgetTrend.isDouble(state.direction) }
    var iob: String? { state.iob.map { "\(DashboardFormat.iob($0)) j" } }
    var cob: String? { state.cob.map { "\(Int($0.rounded())) g" } }

    /// The item needing attention most (the dashboard's equipment tile), nil when all is well.
    var dueEquipment: DashboardGlance.EquipmentItem? {
        DashboardGlance.attention(state.equipment(now: Date())).first
    }

    var patientURL: URL { URL(string: "\(AppLink.origin)/patients/\(patientID.lowercased())")! }
    var bolusURL: URL { HomeWidgetLink.bolus(patientID: patientID).url }
    var equipmentURL: URL { HomeWidgetLink.equipment(patientID: patientID).url }
}

// MARK: - Lock screen, StandBy, Watch, CarPlay

private struct LockScreenGlucose: View {
    let model: LiveGlucoseModel
    @Environment(\.activityFamily) private var family

    var body: some View {
        if family == .small {
            SmallGlucose(model: model)
        } else {
            MediumGlucose(model: model)
        }
    }
}

/// Lock screen (StandBy scales it): name and value on the left, the 2 h sparkline beside them as tall as both and as
/// wide as the rest; under them the change and age on the left, IOB/COB on the right (under the sparkline); a third
/// line only when equipment needs attention. The age has a row of its own so its width does not narrow the sparkline.
private struct MediumGlucose: View {
    let model: LiveGlucoseModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 0) {
                    LiveName(name: model.patientName, size: 13)
                    LiveHero(model: model, size: 44)
                        .padding(.top, 5)
                }
                .layoutPriority(1)
                // Plain shapes, not Swift Charts: a chart on the lock screen crashed the extension (2026-10-27).
                // At least 170 pt: a long name truncates instead of narrowing it.
                LiveSparkline(model: model)
                    .frame(minWidth: 170, maxWidth: .infinity)
                    .frame(height: 64)
            }
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                // Never inside .fixedSize(): with the self-updating age the whole activity drew nothing (2026-10-27).
                LiveAgeLine(model: model)
                Spacer(minLength: 4)
                LiveMetric(key: "IOB", value: model.iob, color: WidgetPalette.insulinText)
                LiveMetric(key: "COB", value: model.cob, color: WidgetPalette.carbsText)
            }
            .padding(.top, 8)
            if let item = model.dueEquipment {
                Rectangle().fill(Color.primary.opacity(0.12)).frame(height: 0.5)
                    .padding(.top, 10)
                LiveEquipmentLine(item: item)
                    .padding(.top, 9)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// Apple Watch Smart Stack and CarPlay: name, value with the trend and IOB/COB beside it, the change and age under.
private struct SmallGlucose: View {
    let model: LiveGlucoseModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            LiveName(name: model.patientName, size: 12)
            HStack(alignment: .center) {
                LiveHero(model: model, size: 32)
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 1) {
                    LiveMetric(key: "IOB", value: model.iob, color: WidgetPalette.insulinText, size: 12)
                    LiveMetric(key: "COB", value: model.cob, color: WidgetPalette.carbsText, size: 12)
                }
            }
            LiveAgeLine(model: model)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

// MARK: - Parts

/// The lock screen's 2 h sparkline drawn with shapes: the 70–180 band, dots in range colours, the newest a bigger dot
/// with a ring and a soft halo (hollow and grey once old). Scaled to its own readings.
private struct LiveSparkline: View {
    private static let levels: [DashboardLevel] = [.normal, .warning, .alarm]
    let model: LiveGlucoseModel

    var body: some View {
        let now = max(Date().timeIntervalSince1970, model.state.readings.last?.first ?? 0)
        // Only the last 2 h: an older reading would sit on the left edge.
        let points = model.state.readings.compactMap { pair -> SparkPoint? in
            pair.count == 2 && pair[1].isFinite && pair[0] >= now - 2 * 3_600 ? SparkPoint(at: pair[0], value: pair[1]) : nil
        }
        let end = now
        let scale = SparkScale(from: end - 2 * 3_600, to: end,
                               low: (points.map(\.value).min() ?? 100) - 22, high: (points.map(\.value).max() ?? 160) + 22)
        let older = Array(points.dropLast())
        ZStack {
            SparkBand(scale: scale).fill(Brand.inRange.opacity(0.14))
            // Indexed by Int: WidgetKit archives the view and every ForEach id must be Encodable (DashboardLevel is
            // not, and the whole activity then rendered as an empty box, 2026-10-27).
            ForEach(0..<Self.levels.count, id: \.self) { index in
                let level = Self.levels[index]
                SparkDots(points: older.filter { DashboardThresholds.glucose(Int($0.value)) == level }, scale: scale, radius: 1.5)
                    .fill(WidgetPalette.glucose(level).opacity(model.isOld ? 0.4 : 1))
            }
            if let last = points.last {
                let color = model.isOld ? Color.secondary : WidgetPalette.glucose(DashboardThresholds.glucose(Int(last.value)))
                if !model.isOld {
                    SparkDots(points: [last], scale: scale, radius: 7).fill(color.opacity(0.22))
                }
                SparkDots(points: [last], scale: scale, radius: 4.5).fill(model.isOld ? Color.secondary : Color(white: 0.1))
                SparkDots(points: [last], scale: scale, radius: 3).fill(model.isOld ? Color(white: 0.1) : color)
            }
        }
    }
}

private struct SparkPoint: Equatable {
    let at: Double
    let value: Double
}

private struct SparkScale {
    let from: Double
    let to: Double
    let low: Double
    let high: Double

    func point(_ p: SparkPoint, in rect: CGRect) -> CGPoint {
        let x = to > from ? (p.at - from) / (to - from) : 1
        let y = high > low ? (p.value - low) / (high - low) : 0.5
        return CGPoint(x: rect.minX + rect.width * min(max(x, 0), 1), y: rect.maxY - rect.height * min(max(y, 0), 1))
    }

    func y(_ value: Double, in rect: CGRect) -> CGFloat {
        let y = high > low ? (value - low) / (high - low) : 0.5
        return rect.maxY - rect.height * min(max(y, 0), 1)
    }
}

private struct SparkBand: Shape {
    let scale: SparkScale

    func path(in rect: CGRect) -> Path {
        guard rect.width.isFinite, rect.height.isFinite, rect.width > 0, rect.height > 0 else { return Path() }
        let top = scale.y(180, in: rect), bottom = scale.y(70, in: rect)
        guard bottom > top else { return Path() }
        return Path(roundedRect: CGRect(x: rect.minX, y: top, width: rect.width, height: bottom - top), cornerRadius: 3)
    }
}

private struct SparkDots: Shape {
    let points: [SparkPoint]
    let scale: SparkScale
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard rect.width.isFinite, rect.height.isFinite, rect.width > 0, rect.height > 0 else { return path }
        for p in points {
            let c = scale.point(p, in: rect.insetBy(dx: 4, dy: 4))
            path.addEllipse(in: CGRect(x: c.x - radius, y: c.y - radius, width: radius * 2, height: radius * 2))
        }
        return path
    }
}

private struct LiveName: View {
    let name: String
    let size: CGFloat
    var color: Color = Brand.petrol

    var body: some View {
        Text(name).font(.system(size: size, weight: .semibold)).foregroundStyle(color).lineLimit(1)
    }
}

/// The value with a bare trend arrow (as the small widget).
private struct LiveHero: View {
    let model: LiveGlucoseModel
    let size: CGFloat

    var body: some View {
        HStack(alignment: .center, spacing: size < 24 ? 2 : 4) {
            Text(model.valueText)
                .font(.system(size: size, weight: .bold, design: .rounded))
                .tracking(size < 24 ? 0 : -1)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let symbol = model.trendSymbol {
                HStack(spacing: -size * 0.2) {
                    ForEach(0..<(model.trendIsDouble ? 2 : 1), id: \.self) { _ in Image(systemName: symbol) }
                }
                .font(.system(size: size * (size < 24 ? 0.75 : 0.52), weight: .bold))
            }
        }
        .foregroundStyle(model.valueColor)
        .staleDimmed(model.isDimmed)
        .padding(.vertical, size < 24 ? 0 : -size * 0.1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(model.state.glucose.map { "Glukoza \($0) mg/dL\(model.isOld ? ", nieaktualna" : "")" } ?? "Brak odczytu")
    }
}

/// "+4 · 3 min temu": the age ticks by itself (the system formats it against the current time, no push needed);
/// once the reading is stale only the age, red and still ticking ("23 minuty temu"; an old change says nothing).
private struct LiveAgeLine: View {
    let model: LiveGlucoseModel

    var body: some View {
        Group {
            if let reading = model.state.readingDate {
                if model.isOld {
                    age(reading)
                        .fontWeight(.semibold)
                        .foregroundStyle(WidgetPalette.levelText(.alarm))
                } else {
                    (deltaText + age(reading).foregroundStyle(.secondary))
                }
            } else {
                Text("brak odczytu").foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 12))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }

    private var deltaText: Text {
        guard let delta = model.state.delta else { return Text("") }
        return Text(DashboardFormat.signedDelta(delta))
            .fontWeight(.semibold)
            .foregroundStyle(model.level == .alarm ? WidgetPalette.levelText(.alarm) : Color.primary)
            + Text(" · ").foregroundStyle(.secondary)
    }

    private func age(_ reading: Date) -> Text {
        // Polish through the extension's CFBundleLocalizations (the system formats it; a locale here is ignored).
        Text(.currentDate, format: .reference(to: reading, allowedFields: [.minute, .hour], maxFieldCount: 1))
    }
}

/// "IOB 1,35 j": small caps label, coloured value; nothing without data.
private struct LiveMetric: View {
    let key: String
    let value: String?
    let color: Color
    var size: CGFloat = 13

    var body: some View {
        if let value {
            (Text("\(key) ").font(.system(size: size * 0.77, weight: .semibold)).foregroundStyle(.secondary)
                + Text(value).font(.system(size: size, weight: .semibold)).foregroundStyle(color))
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize()
        }
    }
}

/// Lock screen's second line: "⚠ Sensor 6 h · wymień dziś".
private struct LiveEquipmentLine: View {
    let item: DashboardGlance.EquipmentItem

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 12, weight: .semibold))
            Text(item.headline).font(.system(size: 12, weight: .semibold))
            if let hint = item.hint { Text("· \(hint)").font(.system(size: 12)).opacity(0.85) }
            Spacer(minLength: 0)
        }
        .foregroundStyle(WidgetPalette.levelText(item.level))
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

/// The expanded island's equipment: grey "Sprzęt OK", or a tinted pill with the item needing attention most.
private struct LiveEquipmentPill: View {
    let item: DashboardGlance.EquipmentItem?

    var body: some View {
        if let item {
            HStack(spacing: 5) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 12, weight: .semibold))
                Text(item.headline).font(.system(size: 12, weight: .semibold)).lineLimit(1)
            }
            .foregroundStyle(WidgetPalette.levelText(item.level))
            .padding(.horizontal, 11)
            .frame(height: 28)
            .background(Capsule().fill(WidgetPalette.level(item.level).opacity(0.18)))
        } else {
            Label("Sprzęt OK", systemImage: "checkmark.circle")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }
}

/// The last 2 h as dots in range colours over the 70–180 band; the newest a bigger dot with a ring and a soft halo,
/// hollow and grey once old. The sparkline (lock screen) scales to its readings; the expanded island's chart uses the
/// dashboard's scale with boluses along the bottom.
private struct LiveChart: View {
    enum Style { case spark, expanded }
    let model: LiveGlucoseModel
    let style: Style

    var body: some View {
        let end = max(Date(), model.state.readings.last.flatMap { $0.first.map(Date.init(timeIntervalSince1970:)) } ?? Date())
        let from = end.addingTimeInterval(-2 * 3_600)
        // Only the last 2 h: Charts draws a reading outside the domain beyond the plot's left edge.
        let points = model.state.readings.compactMap { pair -> (at: Date, value: Int)? in
            pair.count == 2 && pair[0] >= from.timeIntervalSince1970 ? (Date(timeIntervalSince1970: pair[0]), Int(pair[1])) : nil
        }
        let values = points.map { Double($0.value) }
        let floor = 40.0
        // About a fifth of the 36 pt chart, so the boluses read as ticks.
        let doseHeight = 40.0
        let top = max(220, (((values.max() ?? 0) + 10) / 25).rounded(.up) * 25)
        let domain: ClosedRange<Double> = style == .spark
            ? ((values.min() ?? 100) - 22)...((values.max() ?? 160) + 22)
            : (floor - doseHeight)...top
        let bandLow = max(70, domain.lowerBound), bandHigh = min(180, domain.upperBound)
        let last = points.last
        let ring = Color(white: 0.1)
        Chart {
            if bandHigh > bandLow {
                RectangleMark(xStart: .value("od", from), xEnd: .value("do", end),
                              yStart: .value("min", bandLow), yEnd: .value("max", bandHigh))
                    .foregroundStyle(Brand.inRange.opacity(0.14))
            }
            ForEach(Array(points.dropLast().enumerated()), id: \.offset) { _, point in
                PointMark(x: .value("czas", point.at), y: .value("mg/dL", point.value))
                    .symbolSize(style == .spark ? 8 : 10)
                    .foregroundStyle(WidgetPalette.glucose(DashboardThresholds.glucose(point.value)).opacity(model.isOld ? 0.4 : 1))
            }
            if let last {
                if model.isOld {
                    RuleMark(xStart: .value("od", last.at), xEnd: .value("do", end), y: .value("mg/dL", last.value))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [1.5, 3]))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                    // Stacked plain marks: custom symbol views crash the extension when WidgetKit archives the view.
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(70).foregroundStyle(Color.secondary)
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(30).foregroundStyle(ring)
                } else {
                    let color = WidgetPalette.glucose(DashboardThresholds.glucose(last.value))
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(200).foregroundStyle(color.opacity(0.22))
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(80).foregroundStyle(ring)
                    PointMark(x: .value("czas", last.at), y: .value("mg/dL", last.value))
                        .symbolSize(42).foregroundStyle(color)
                }
            }
            if style == .expanded {
                ForEach(Array(model.state.boluses.enumerated()), id: \.offset) { _, dose in
                    if dose.count == 2 {
                        BarMark(x: .value("czas", Date(timeIntervalSince1970: dose[0])),
                                yStart: .value("od", floor - doseHeight), yEnd: .value("do", floor - 2), width: 3)
                            .foregroundStyle(WidgetPalette.insulinText)

                    }
                }
            }
        }
        .chartXScale(domain: from...end)
        .chartYScale(domain: domain)
        // Axes hidden and no annotations, as the activity's chart that never crashed (hour labels and dose numbers
        // came with the build whose extension crashed on the phones, 2026-10-27).
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
    }
}
