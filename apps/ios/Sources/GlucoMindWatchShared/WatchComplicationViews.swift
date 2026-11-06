import SwiftUI
import WidgetKit

/// The watch-face complications, as the approved mockups (artifacts/watch-complications-mockups.html, the recommended
/// variant of each family). No words for the level: the number's colour and the arrow say it, and only under 54 a
/// filled shape (it works in the tinted face too). A reading older than 15 min is greyed, struck through and gets a
/// clock instead of the arrow, so an old value never looks current.
public enum WatchPalette {
    public static let inRange = Color(red: 0x2F / 255, green: 0xC2 / 255, blue: 0x74 / 255)
    public static let high = Color(red: 0xFF / 255, green: 0xC5 / 255, blue: 0x3D / 255)
    public static let alarm = Color(red: 0xFF / 255, green: 0x5A / 255, blue: 0x4F / 255)
    /// The patient's name: the brand's light teal on the dark face.
    public static let name = Color(red: 0x5E / 255, green: 0xEA / 255, blue: 0xD4 / 255)
    public static let secondary = Color(white: 0.92).opacity(0.62)

    public static func color(_ reading: WatchReading) -> Color {
        guard reading.kind == .value else { return secondary }
        switch reading.level {
        case .inRange: return inRange
        case .high: return high
        case .low, .veryHigh, .urgentLow: return alarm
        }
    }

    /// The Smart Stack tile's background: the state at a glance (HIG: a background colour that carries meaning).
    public static func tileBackground(_ reading: WatchReading?) -> LinearGradient {
        func gradient(_ top: UInt32, _ bottom: UInt32) -> LinearGradient {
            LinearGradient(colors: [rgb(top), rgb(bottom)], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
        guard let reading, reading.kind != .noData else { return gradient(0x346C73, 0x1D4B51) }
        if reading.kind == .stale { return gradient(0x3A3A3C, 0x2C2C2E) }
        switch reading.level {
        case .inRange: return gradient(0x346C73, 0x1D4B51)
        case .high: return gradient(0x6F5609, 0x4A3A06)
        case .veryHigh: return gradient(0x7D3A0C, 0x5C2408)
        case .low: return gradient(0x7F241C, 0x5C1612)
        case .urgentLow: return gradient(0xE5302A, 0xE5302A)
        }
    }

    static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// What a complication shows: a patient's reading, or why there is none.
public enum WatchComplicationContent {
    case reading(WatchGlance)
    /// No working token: the phone's hand-over has not reached the watch, or the phone is signed out.
    case signedOut
    case noPatient
    /// No answer from the server and no reading saved on the watch.
    case unavailable
}

// MARK: - Building blocks

/// The trend arrow drawn as in the mockups (a stroke, not a font glyph): one shaft and head, two heads for fast.
struct TrendArrow: View {
    let reading: WatchReading
    var size: CGFloat
    var lineWidth: CGFloat

    var body: some View {
        Canvas { context, canvas in
            let s = size
            func arrow(dy: CGFloat) -> Path {
                var path = Path()
                path.move(to: CGPoint(x: -0.42 * s, y: dy))
                path.addLine(to: CGPoint(x: 0.36 * s, y: dy))
                path.move(to: CGPoint(x: 0.04 * s, y: dy - 0.32 * s))
                path.addLine(to: CGPoint(x: 0.4 * s, y: dy))
                path.addLine(to: CGPoint(x: 0.04 * s, y: dy + 0.32 * s))
                return path
            }
            var path = reading.isDoubleArrow ? arrow(dy: -0.2 * s) : arrow(dy: 0)
            if reading.isDoubleArrow { path.addPath(arrow(dy: 0.2 * s)) }
            let transform = CGAffineTransform(translationX: canvas.width / 2, y: canvas.height / 2)
                .rotated(by: reading.arrowAngle * .pi / 180)
            context.stroke(path.applying(transform), with: .foreground,
                           style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityLabel(GlucoseTrend.label(reading.direction) ?? "")
    }
}

/// The glucose number: rounded, bold, tabular; greyed with a strike line once it is old.
struct GlucoseNumber: View {
    let reading: WatchReading
    let size: CGFloat
    var color: Color

    var body: some View {
        Text(reading.valueText)
            .font(.system(size: size, weight: .bold, design: .rounded))
            .monospacedDigit()
            .tracking(-size * 0.03)
            .foregroundStyle(reading.kind == .stale ? Color.white.opacity(0.42) : color)
            .overlay {
                if reading.kind == .stale {
                    Capsule().fill(Color.white.opacity(0.85)).frame(height: max(1.3, size * 0.07)).padding(.horizontal, 1.2)
                }
            }
            .lineLimit(1)
            // Never "2…": a number cut short is the one thing a glance must not show. Smaller watches shrink it.
            .minimumScaleFactor(0.5)
            .layoutPriority(1)
    }
}

/// Under 54: the shape filled, with the content cut out of it, so it reads on any face and in the tinted mode, where
/// a dark text colour would turn white.
struct CutOut<Background: Shape, Content: View>: View {
    let shape: Background
    let fill: Color
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            shape.fill(fill)
            content.blendMode(.destinationOut)
        }
        .compositingGroup()
        .widgetAccentable()
    }
}

struct ClockGlyph: View {
    var size: CGFloat
    var body: some View {
        Image(systemName: "clock").font(.system(size: size, weight: .semibold))
    }
}

// MARK: - Circular

/// Circular A: arrow on top, the number, the age under it. A caregiver with more than one patient sees the patient's
/// letter next to the arrow (each patient in their own complication).
public struct CircularComplication: View {
    let content: WatchComplicationContent
    let initial: String?
    let now: Date

    public init(content: WatchComplicationContent, initial: String?, now: Date) {
        self.content = content
        self.initial = initial
        self.now = now
    }

    public var body: some View {
        switch content {
        case .signedOut, .noPatient, .unavailable:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 1) {
                    Image("Logo").resizable().scaledToFit().frame(width: 18, height: 18).widgetAccentable()
                    Text(content.shortNotice).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                }
            }
        case .reading(let glance):
            let reading = WatchReading(glance, now: now)
            if reading.isUrgent {
                CutOut(shape: Circle(), fill: WatchPalette.alarm) { inner(reading) }
            } else {
                ZStack {
                    AccessoryWidgetBackground()
                    inner(reading)
                }
            }
        }
    }

    private func inner(_ reading: WatchReading) -> some View {
        let color = WatchPalette.color(reading)
        // Placed by the circle's centre, as in the mockup (arrow at the top, age low but inside the circle's chord).
        return GeometryReader { proxy in
            let d = min(proxy.size.width, proxy.size.height)
            ZStack {
                HStack(spacing: 2) {
                    if let initial { Text(initial).font(.system(size: d * 0.17, weight: .heavy)).foregroundStyle(.secondary) }
                    if reading.showsArrow {
                        TrendArrow(reading: reading, size: d * 0.2, lineWidth: 2.1).foregroundStyle(color).widgetAccentable()
                    } else {
                        ClockGlyph(size: d * 0.17).foregroundStyle(reading.kind == .noData ? Color.secondary : Color.white)
                    }
                }
                .offset(y: -d * 0.29)
                GlucoseNumber(reading: reading, size: d * ((reading.value ?? 0) >= 100 ? 0.38 : 0.42), color: color)
                    .widgetAccentable()
                    .offset(y: d * 0.02)
                Text(reading.kind == .noData ? "brak" : reading.ageText)
                    .font(.system(size: d * 0.16, weight: reading.kind == .stale || reading.ageIsLate ? .heavy : .semibold))
                    .foregroundStyle(reading.kind == .stale ? Color.white : reading.ageIsLate ? WatchPalette.high : WatchPalette.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .offset(y: d * 0.3)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }
}

// MARK: - Corner

/// Corner A: the number in the corner; the curved label carries the arrow, the change and the age (the patient's
/// letter first for a caregiver with more patients: each patient in their own corner).
public struct CornerComplication: View {
    let content: WatchComplicationContent
    let initial: String?
    let now: Date

    public init(content: WatchComplicationContent, initial: String?, now: Date) {
        self.content = content
        self.initial = initial
        self.now = now
    }

    public var body: some View {
        switch content {
        case .signedOut, .noPatient, .unavailable:
            Image("Logo").resizable().scaledToFit().padding(4).widgetAccentable()
                .widgetLabel { Text(content.lineNotice) }
        case .reading(let glance):
            let reading = WatchReading(glance, now: now)
            number(reading)
                .widgetLabel { label(reading) }
        }
    }

    @ViewBuilder
    private func number(_ reading: WatchReading) -> some View {
        let text = GlucoseNumber(reading: reading, size: (reading.value ?? 0) >= 100 ? 17 : 20, color: WatchPalette.color(reading))
        if reading.isUrgent {
            CutOut(shape: Circle(), fill: WatchPalette.alarm) { text }
        } else {
            text.widgetAccentable()
        }
    }

    private func label(_ reading: WatchReading) -> Text {
        let prefix = initial.map { Text("\($0) ").foregroundColor(WatchPalette.secondary) } ?? Text("")
        switch reading.kind {
        case .noData:
            return prefix + Text("brak odczytu").foregroundColor(WatchPalette.secondary)
        case .stale:
            return prefix + Text(initial == nil ? "brak odczytu \(reading.ageText)" : "◷ \(reading.ageText)").foregroundColor(WatchPalette.high)
        case .value:
            let delta = reading.deltaText.map { Text("\($0)").foregroundColor(.white) } ?? Text("")
            let age = Text(reading.ageText).foregroundColor(reading.ageIsLate ? WatchPalette.high : WatchPalette.secondary)
            let arrow = reading.showsArrow ? Text("\(reading.arrowText) ").foregroundColor(WatchPalette.color(reading)) : Text("")
            let separator = reading.deltaText == nil ? Text("") : Text(" · ").foregroundColor(WatchPalette.secondary.opacity(0.5))
            return prefix + arrow + delta + separator + age
        }
    }
}

// MARK: - Inline

public struct InlineComplication: View {
    let content: WatchComplicationContent
    let now: Date

    public init(content: WatchComplicationContent, now: Date) {
        self.content = content
        self.now = now
    }

    public var body: some View {
        switch content {
        case .signedOut, .noPatient, .unavailable: Text(content.lineNotice)
        case .reading(let glance): Text(WatchReading(glance, now: now).inlineText).monospacedDigit()
        }
    }
}

/// Two patients in one line: "O 112↗ · M 87↘" (never alternating between patients).
public struct InlinePairComplication: View {
    let first: WatchComplicationContent
    let second: WatchComplicationContent
    let initials: [String: String]
    let now: Date

    public init(first: WatchComplicationContent, second: WatchComplicationContent, initials: [String: String], now: Date) {
        self.first = first
        self.second = second
        self.initials = initials
        self.now = now
    }

    public var body: some View {
        if first.replacesPair {
            Text(first.lineNotice)
        } else {
            Text("\(part(first)) · \(part(second))").monospacedDigit()
        }
    }

    private func part(_ content: WatchComplicationContent) -> String {
        guard case let .reading(glance) = content else { return "–" }
        return "\(initials[glance.patient.id] ?? "") \(WatchReading(glance, now: now).compactText)"
    }
}

// MARK: - Rectangular (watch face) and Smart Stack

/// Rectangular A on the face: name and age, the number with arrow and change, IOB and COB. In the Smart Stack (where
/// the system shows the widget's background) the same widget becomes the tile whose colour carries the state.
public struct RectangularComplication: View {
    let content: WatchComplicationContent
    let now: Date
    /// The watch app draws it outside a widget, where the system does not say face or Smart Stack.
    let tileOverride: Bool?
    @Environment(\.showsWidgetContainerBackground) private var showsBackground
    @Environment(\.widgetRenderingMode) private var renderingMode

    public init(content: WatchComplicationContent, now: Date, tile: Bool? = nil) {
        self.content = content
        self.now = now
        self.tileOverride = tile
    }

    private var inSmartStack: Bool { tileOverride ?? showsBackground }

    public var body: some View {
        Group {
            if inSmartStack { tile } else { face }
        }
        .containerBackground(for: .widget) {
            if renderingMode == .fullColor {
                WatchPalette.tileBackground(reading)
            } else {
                Color(white: 0.11)
            }
        }
    }

    private var reading: WatchReading? {
        if case let .reading(glance) = content { return WatchReading(glance, now: now) }
        return nil
    }

    // On the face.
    @ViewBuilder
    private var face: some View {
        switch content {
        case .signedOut, .noPatient, .unavailable:
            HStack(spacing: 8) {
                Image("Logo").resizable().scaledToFit().frame(width: 30, height: 30).widgetAccentable()
                VStack(alignment: .leading, spacing: 1) {
                    Text("Mellis").font(.system(size: 14, weight: .bold))
                    Text(content.fullNotice)
                        .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        case .reading(let glance) where WatchChart.canDraw(glance, now: now):
            // Variant A of the chart mockups: value, arrow and change on the left, the last 2 h on the right.
            let reading = WatchReading(glance, now: now)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(glance.patient.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(WatchPalette.name)
                        .lineLimit(1).minimumScaleFactor(0.75).widgetAccentable()
                    Spacer(minLength: 4)
                    ageLabel(reading, long: false).fixedSize()
                }
                chartRow(glance, reading, size: 36, onTile: false)
            }
        case .reading(let glance):
            let reading = WatchReading(glance, now: now)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(glance.patient.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WatchPalette.name)
                        .lineLimit(1).minimumScaleFactor(0.75).widgetAccentable()
                    Spacer(minLength: 4)
                    ageLabel(reading, long: true)
                }
                valueRow(reading, size: 34, arrow: 17, deltaSize: 15)
                switch reading.kind {
                case .noData:
                    Text("Brak danych z Nightscout.").font(.system(size: 11)).foregroundStyle(.secondary)
                case .stale:
                    // IOB from the same old read would look current: left out.
                    EmptyView()
                case .value:
                    insulinLine(reading).font(.system(size: 11.5))
                }
            }
        }
    }

    // In the Smart Stack.
    @ViewBuilder
    private var tile: some View {
        switch content {
        case .signedOut, .noPatient, .unavailable:
            VStack(alignment: .leading, spacing: 2) {
                tileHeader(name: "Mellis")
                Spacer(minLength: 0)
                Text(content.tileNotice.title).font(.system(size: 13, weight: .bold)).lineLimit(1).minimumScaleFactor(0.8)
                Text(content.tileNotice.detail).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.72))
                    .lineLimit(2).minimumScaleFactor(0.8)
            }
        case .reading(let glance) where WatchChart.canDraw(glance, now: now):
            let reading = WatchReading(glance, now: now)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    tileHeader(name: glance.patient.name)
                    Spacer(minLength: 4)
                    ageLabel(reading, long: false).fixedSize()
                }
                chartRow(glance, reading, size: 34, onTile: true)
            }
            .foregroundStyle(.white)
        case .reading(let glance):
            let reading = WatchReading(glance, now: now)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    tileHeader(name: glance.patient.name)
                    Spacer(minLength: 4)
                    ageLabel(reading, long: false).fixedSize()
                }
                valueRow(reading, size: 38, arrow: 19, deltaSize: 16, onTile: true)
                Spacer(minLength: 0)
                switch reading.kind {
                case .stale:
                    Text("brak odczytu od \(reading.ageText)").font(.system(size: 11, weight: .heavy))
                case .noData:
                    Text("Brak danych z Nightscout.").font(.system(size: 11)).foregroundStyle(.white.opacity(0.72))
                case .value:
                    HStack { Spacer(minLength: 0); insulinLine(reading, onTile: true).font(.system(size: 11)) }
                }
            }
            .foregroundStyle(.white)
        }
    }

    private func tileHeader(name: String) -> some View {
        HStack(spacing: 4) {
            Image("Logo").resizable().scaledToFit().frame(width: 15, height: 15)
            Text(name).font(.system(size: 13, weight: .bold)).lineLimit(1).minimumScaleFactor(0.75)
        }
    }

    @ViewBuilder
    private func ageLabel(_ reading: WatchReading, long: Bool) -> some View {
        switch reading.kind {
        case .noData:
            Text("brak odczytu").font(.system(size: 11.5)).foregroundStyle(.secondary)
        case .stale:
            HStack(spacing: 3) {
                ClockGlyph(size: 10)
                ViewThatFits(in: .horizontal) {
                    if long { Text("brak odczytu \(reading.ageText)").fixedSize() }
                    Text(reading.ageText).fixedSize()
                }
                .font(.system(size: 11.5, weight: .heavy))
            }
            .foregroundStyle(inSmartStack ? Color.white : WatchPalette.high)
            .lineLimit(1)
        case .value:
            Text(long ? "\(reading.ageText) temu" : "\(reading.ageText) temu")
                .font(.system(size: 11.5, weight: reading.ageIsLate ? .heavy : .medium))
                .foregroundStyle(reading.ageIsLate ? WatchPalette.high : inSmartStack ? Color.white.opacity(0.72) : WatchPalette.secondary)
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private func valueRow(_ reading: WatchReading, size: CGFloat, arrow: CGFloat, deltaSize: CGFloat, onTile: Bool = false) -> some View {
        // On the coloured tile the number is white (the background says the state); on the face it is coloured.
        let color = onTile && renderingMode == .fullColor ? Color.white : WatchPalette.color(reading)
        HStack(alignment: .center, spacing: 6) {
            Group {
                if reading.isUrgent && !onTile {
                    CutOut(shape: RoundedRectangle(cornerRadius: size * 0.2), fill: WatchPalette.alarm) {
                        HStack(spacing: 4) {
                            GlucoseNumber(reading: reading, size: size, color: .black)
                            if reading.showsArrow { TrendArrow(reading: reading, size: arrow, lineWidth: 3) }
                        }
                        .padding(.horizontal, 5)
                    }
                    .fixedSize()
                } else {
                    GlucoseNumber(reading: reading, size: size, color: color).widgetAccentable()
                    if reading.showsArrow {
                        TrendArrow(reading: reading, size: arrow, lineWidth: 3.1).foregroundStyle(color).widgetAccentable()
                    }
                }
            }
            if reading.kind == .value, let delta = reading.deltaText {
                ViewThatFits(in: .horizontal) {
                    (Text(delta).font(.system(size: deltaSize, weight: .semibold, design: .rounded))
                        + Text(" mg/dl").font(.system(size: 9, weight: .medium)).foregroundColor(onTile ? .white.opacity(0.72) : WatchPalette.secondary))
                        .fixedSize()
                    Text(delta).font(.system(size: deltaSize, weight: .semibold, design: .rounded)).fixedSize()
                }
                .monospacedDigit()
            }
            Spacer(minLength: 0)
        }
    }

    /// Value and arrow over the change on the left (about half the width), the chart filling the rest.
    private func chartRow(_ glance: WatchGlance, _ reading: WatchReading, size: CGFloat, onTile: Bool) -> some View {
        let color = onTile && renderingMode == .fullColor ? Color.white : WatchPalette.color(reading)
        return HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                Group {
                    if reading.isUrgent && !onTile {
                        CutOut(shape: RoundedRectangle(cornerRadius: size * 0.2), fill: WatchPalette.alarm) {
                            HStack(spacing: 3) {
                                GlucoseNumber(reading: reading, size: size, color: .black)
                                if reading.showsArrow { TrendArrow(reading: reading, size: 17, lineWidth: 2.6) }
                            }
                            .padding(.horizontal, 4)
                        }
                        .fixedSize()
                    } else {
                        HStack(spacing: 3) {
                            GlucoseNumber(reading: reading, size: size, color: color).widgetAccentable()
                            if reading.showsArrow {
                                TrendArrow(reading: reading, size: 17, lineWidth: 2.6).foregroundStyle(color).widgetAccentable()
                            }
                        }
                    }
                }
                if reading.kind == .value, let delta = reading.deltaText {
                    (Text(delta).font(.system(size: 14, weight: .semibold, design: .rounded))
                        + Text(" mg/dl").font(.system(size: 10, weight: .medium)).foregroundColor(onTile ? .white.opacity(0.72) : WatchPalette.secondary))
                        .monospacedDigit()
                        .lineLimit(1)
                }
            }
            // Room for three digits and the arrow, so the chart starts at the same place whatever the number; a small
            // watch's chart is narrower, not its number.
            .fixedSize(horizontal: true, vertical: false)
            .frame(minWidth: size * 2.4, alignment: .leading)
            GlucoseChart(points: glance.history ?? [], now: now, stale: reading.kind != .value,
                         lineColor: onTile && renderingMode == .fullColor ? .white : (reading.kind == .value ? WatchPalette.color(reading) : WatchPalette.secondary),
                         onTile: onTile)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.top, 4)
        }
    }

    private func insulinLine(_ reading: WatchReading, onTile: Bool = false) -> Text {
        let label = onTile ? Color.white.opacity(0.72) : WatchPalette.secondary
        var line = Text("")
        if let iob = reading.iobText {
            line = line + Text("IOB ").foregroundColor(label) + Text(iob)
        }
        if let cob = reading.cobText, reading.kind == .value {
            line = line + Text(reading.iobText == nil ? "COB " : "  ·  COB ").foregroundColor(label) + Text(cob)
        }
        return line
    }
}

/// Two patients, rectangular. On the face: two rows, names in full, numbers in one column; under 54 that patient's row
/// is filled. In the Smart Stack: two tiles in a fixed order, each with its own background, so one patient's alarm does
/// not flood the other's.
public struct RectangularPairComplication: View {
    let first: WatchComplicationContent
    let second: WatchComplicationContent
    let now: Date
    let tileOverride: Bool?
    @Environment(\.showsWidgetContainerBackground) private var showsBackground
    @Environment(\.widgetRenderingMode) private var renderingMode

    public init(first: WatchComplicationContent, second: WatchComplicationContent, now: Date, tile: Bool? = nil) {
        self.first = first
        self.second = second
        self.now = now
        self.tileOverride = tile
    }

    private var inSmartStack: Bool { tileOverride ?? showsBackground }

    public var body: some View {
        Group {
            if first.replacesPair {
                RectangularComplication(content: first, now: now)
            } else if inSmartStack {
                HStack(spacing: 4) {
                    tile(first)
                    tile(second)
                }
                .padding(4)
                .containerBackground(for: .widget) { Color.black }
            } else {
                VStack(spacing: 0) {
                    row(first)
                    Rectangle().fill(Color.white.opacity(0.28)).frame(height: 0.8)
                    row(second)
                }
                .containerBackground(for: .widget) { Color.black }
            }
        }
    }

    @ViewBuilder
    private func row(_ content: WatchComplicationContent) -> some View {
        if case let .reading(glance) = content {
            let reading = WatchReading(glance, now: now)
            let line = rowContent(glance, reading, ink: reading.isUrgent)
            if reading.isUrgent {
                CutOut(shape: RoundedRectangle(cornerRadius: 9), fill: WatchPalette.alarm) { line }
            } else {
                line
            }
        } else {
            Text("–").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }

    private func rowContent(_ glance: WatchGlance, _ reading: WatchReading, ink: Bool) -> some View {
        let color = ink ? Color.black : WatchPalette.color(reading)
        return HStack(spacing: 0) {
            Text(glance.patient.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(ink ? Color.black : WatchPalette.name)
                .lineLimit(1).minimumScaleFactor(0.7)
                .frame(maxWidth: 62, alignment: .leading)
                .layoutPriority(-1)
                .widgetAccentable()
            HStack(spacing: 5) {
                GlucoseNumber(reading: reading, size: 25, color: color).widgetAccentable()
                if reading.showsArrow {
                    TrendArrow(reading: reading, size: 14, lineWidth: 2.6).foregroundStyle(color).widgetAccentable()
                }
            }
            .fixedSize()
            Spacer(minLength: 2)
            VStack(alignment: .trailing, spacing: 0) {
                switch reading.kind {
                case .noData:
                    Text("brak odczytu").font(.system(size: 10)).foregroundStyle(.secondary)
                case .stale:
                    HStack(spacing: 2) { ClockGlyph(size: 9); Text(reading.ageText).font(.system(size: 12, weight: .heavy)) }
                        .foregroundStyle(WatchPalette.high)
                    Text("brak odczytu").font(.system(size: 9.5)).foregroundStyle(.secondary)
                case .value:
                    Text(reading.ageText).font(.system(size: 11.5, weight: reading.ageIsLate ? .heavy : .medium))
                        .foregroundStyle(ink ? Color.black : reading.ageIsLate ? WatchPalette.high : WatchPalette.secondary)
                    Text(reading.deltaText ?? "").font(.system(size: 11.5, design: .rounded)).foregroundStyle(ink ? Color.black : Color.white)
                }
            }
            .monospacedDigit()
            .lineLimit(1)
            .fixedSize()
        }
        .padding(.horizontal, 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func tile(_ content: WatchComplicationContent) -> some View {
        let reading: WatchReading? = { if case let .reading(glance) = content { return WatchReading(glance, now: now) } else { return nil } }()
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 16).fill(renderingMode == .fullColor ? AnyShapeStyle(WatchPalette.tileBackground(reading)) : AnyShapeStyle(Color(white: 0.15)))
            if case let .reading(glance) = content, let reading {
                VStack(alignment: .leading, spacing: 0) {
                    Text(glance.patient.name).font(.system(size: 12, weight: .bold)).lineLimit(1).minimumScaleFactor(0.75)
                    Spacer(minLength: 0)
                    HStack(spacing: 3) {
                        GlucoseNumber(reading: reading, size: 30, color: renderingMode == .fullColor ? .white : WatchPalette.color(reading))
                        if reading.showsArrow {
                            TrendArrow(reading: reading, size: 14, lineWidth: 2.8)
                        }
                    }
                    Spacer(minLength: 0)
                    switch reading.kind {
                    case .stale:
                        HStack(spacing: 3) { ClockGlyph(size: 9); Text(reading.ageText).font(.system(size: 10.5, weight: .heavy)) }
                    case .noData:
                        Text("brak odczytu").font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.72))
                    case .value:
                        Text(reading.changeAndAgeText).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.72))
                    }
                }
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(.white)
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
            } else {
                Text("–").padding(9)
            }
        }
    }
}

/// Two patients side by side on the face (variant 2B of the mockups): bigger numbers than the two rows, at the cost of
/// the room for names. Under 54 only that patient's number is filled. In the Smart Stack the two tiles, which are side
/// by side already.
public struct RectangularPairColumnsComplication: View {
    let first: WatchComplicationContent
    let second: WatchComplicationContent
    let now: Date
    let tileOverride: Bool?
    @Environment(\.showsWidgetContainerBackground) private var showsBackground

    public init(first: WatchComplicationContent, second: WatchComplicationContent, now: Date, tile: Bool? = nil) {
        self.first = first
        self.second = second
        self.now = now
        self.tileOverride = tile
    }

    public var body: some View {
        if first.replacesPair || (tileOverride ?? showsBackground) {
            RectangularPairComplication(first: first, second: second, now: now, tile: tileOverride)
        } else {
            HStack(spacing: 6) {
                column(first)
                Rectangle().fill(Color.white.opacity(0.28)).frame(width: 0.8).padding(.vertical, 6)
                column(second)
            }
            .padding(.horizontal, 2)
            .containerBackground(for: .widget) { Color.black }
        }
    }

    @ViewBuilder
    private func column(_ content: WatchComplicationContent) -> some View {
        if case let .reading(glance) = content {
            let reading = WatchReading(glance, now: now)
            // The number as big as the face's height allows, the name and the footer right next to it.
            GeometryReader { proxy in
                let size = min(34, proxy.size.height * 0.5, proxy.size.width * 0.41)
                VStack(alignment: .leading, spacing: 1) {
                    Text(glance.patient.name).font(.system(size: 12, weight: .semibold)).foregroundStyle(WatchPalette.name)
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .widgetAccentable()
                    value(reading, size: size)
                        .frame(height: size)
                    footer(reading)
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
            }
        } else {
            Text("–").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func value(_ reading: WatchReading, size: CGFloat) -> some View {
        let color = WatchPalette.color(reading)
        let arrow = size * 0.47
        if reading.isUrgent {
            CutOut(shape: RoundedRectangle(cornerRadius: 8), fill: WatchPalette.alarm) {
                HStack(spacing: 2) {
                    GlucoseNumber(reading: reading, size: size, color: .black)
                    if reading.showsArrow { TrendArrow(reading: reading, size: arrow, lineWidth: 2.8) }
                }
                .padding(.horizontal, 3)
            }
            .fixedSize(horizontal: true, vertical: false)
        } else {
            HStack(spacing: 2) {
                GlucoseNumber(reading: reading, size: size, color: color).widgetAccentable()
                if reading.showsArrow {
                    TrendArrow(reading: reading, size: arrow, lineWidth: 2.8).foregroundStyle(color).widgetAccentable()
                }
            }
        }
    }

    @ViewBuilder
    private func footer(_ reading: WatchReading) -> some View {
        Group {
            switch reading.kind {
            case .noData:
                Text("brak odczytu").foregroundStyle(.secondary)
            case .stale:
                HStack(spacing: 2) {
                    ClockGlyph(size: 9)
                    Text(reading.ageText).fontWeight(.heavy)
                }
                .foregroundStyle(WatchPalette.high)
            case .value:
                Text(reading.changeAndAgeText)
                    .fontWeight(reading.ageIsLate ? .heavy : .medium)
                    .foregroundStyle(reading.ageIsLate ? WatchPalette.high : WatchPalette.secondary)
            }
        }
        .font(.system(size: 10.5))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.85)
    }
}

extension WatchComplicationContent {
    /// A notice about the whole watch, not about one patient: shown instead of the two patients.
    var replacesPair: Bool {
        switch self {
        case .signedOut, .unavailable: return true
        case .noPatient, .reading: return false
        }
    }

    /// The circular complication: one or two words.
    var shortNotice: String {
        switch self {
        case .signedOut: return "Otwórz"
        case .noPatient: return "Brak osób"
        case .unavailable, .reading: return "Brak sieci"
        }
    }

    /// A curved or inline label.
    var lineNotice: String {
        switch self {
        case .signedOut: return "Otwórz Mellis na iPhonie"
        case .noPatient: return "Mellis: brak osób"
        case .unavailable, .reading: return "Mellis: brak połączenia"
        }
    }

    /// Under the name on the rectangular complication.
    var fullNotice: String {
        switch self {
        case .signedOut: return "Otwórz aplikację na iPhonie i na zegarku."
        case .noPatient: return "Brak osób na koncie."
        case .unavailable, .reading: return "Nie udało się połączyć z serwerem."
        }
    }

    var tileNotice: (title: String, detail: String) {
        switch self {
        case .signedOut: return ("Otwórz aplikację", "na iPhonie i na zegarku.")
        case .noPatient: return ("Brak osób", "Dodaj osobę w aplikacji.")
        case .unavailable, .reading: return ("Brak połączenia", "Nie udało się połączyć z serwerem.")
        }
    }
}

/// When the rectangular complication has a chart.
public enum WatchChart {
    /// Hours of readings the watch asks for (GET /v1/watch/glance?hours=).
    public static let hours = 2

    /// A chart needs at least two readings in the window and a reading less than an hour old.
    public static func canDraw(_ glance: WatchGlance, now: Date) -> Bool {
        let from = now.addingTimeInterval(-Double(hours) * 3_600)
        return (glance.history ?? []).filter { $0.at >= from }.count >= 2 && WatchReading(glance, now: now).kind != .noData
    }
}

/// The last 2 h (direction A of artifacts/watch-chart-proposals.html): two thin rails at 70 and 180, a smooth line
/// through every reading coloured by range, a dot on the newest reading. The scale, the gaps and the curve are in
/// WatchChartLayout. Old data: the line greys and the dot is hollow. On a tile and in the tinted face the line has one
/// colour, in the accent group; the rails and the gap marks stay out of it.
struct GlucoseChart: View {
    let points: [WatchPoint]
    let now: Date
    let stale: Bool
    let lineColor: Color
    let onTile: Bool
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.isLuminanceReduced) private var luminanceReduced

    private static let topInset: CGFloat = 3.5
    private static let bottomInset: CGFloat = 3.5
    private static let leftInset: CGFloat = 1.5
    private static let rightInset: CGFloat = 3.5
    /// How far a connector stays from the line's ends, and the shortest distance worth one.
    private static let connectorInset: CGFloat = 3.5
    private static let shortestConnector: CGFloat = 9
    private static let absenceHeight: CGFloat = 1.2

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let from = now.addingTimeInterval(-Double(WatchChart.hours) * 3_600)
            let x: (TimeInterval) -> CGFloat = { at in
                let width = size.width - Self.leftInset - Self.rightInset
                return Self.leftInset + CGFloat((at - from.timeIntervalSince1970) / now.timeIntervalSince(from)) * width
            }
            let y: (Double) -> CGFloat = { value in
                let height = size.height - Self.topInset - Self.bottomInset
                return Self.topInset + CGFloat(1 - WatchChartLayout.height(of: value)) * height
            }
            let point: (WatchChartLayout.Sample) -> CGPoint = { CGPoint(x: x($0.at), y: y($0.value)) }
            let visible = points.filter { $0.at >= from && $0.at <= now.addingTimeInterval(60) }
            let samples = visible.map { WatchChartLayout.Sample(at: $0.at.timeIntervalSince1970, value: Double($0.value)) }
            let parts = WatchChartLayout.parts(samples, now: now.timeIntervalSince1970)
            ZStack(alignment: .topLeading) {
                Path { path in
                    for value in [70.0, 180.0] {
                        path.move(to: CGPoint(x: 0.5, y: y(value)))
                        path.addLine(to: CGPoint(x: size.width - 0.5, y: y(value)))
                    }
                }
                .stroke(Color.white.opacity(luminanceReduced ? 0.16 : onTile ? 0.34 : 0.26), style: StrokeStyle(lineWidth: 1, lineCap: .round))
                Path { path in
                    for part in parts {
                        switch part {
                        case let .connector(start, end):
                            Self.addConnector(to: &path, from: point(start), to: point(end))
                        case let .absence(start, end):
                            path.move(to: CGPoint(x: x(start), y: size.height - Self.absenceHeight))
                            path.addLine(to: CGPoint(x: x(end), y: size.height - Self.absenceHeight))
                        case .line, .dot:
                            break
                        }
                    }
                }
                .stroke(Color.white.opacity(onTile ? 0.7 : 0.55), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [0, 4]))
                Path { path in
                    for case let .line(run) in parts {
                        let runPoints = run.map(point)
                        path.move(to: runPoints[0])
                        for segment in WatchChartLayout.curve(through: runPoints) {
                            path.addCurve(to: segment.end, control1: segment.control1, control2: segment.control2)
                        }
                    }
                }
                .stroke(lineStyle(y: y, height: size.height), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                .widgetAccentable()
                ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                    if case let .dot(sample) = part {
                        Circle()
                            .fill(lineStyle(for: sample.value))
                            .frame(width: 3, height: 3)
                            .position(point(sample))
                            .widgetAccentable()
                    }
                }
                if let last = samples.last {
                    if stale {
                        Circle()
                            .stroke(Color.white.opacity(0.45), lineWidth: 1.5)
                            .frame(width: 5.25, height: 5.25)
                            .position(point(last))
                    } else {
                        Circle()
                            .fill(lineColor)
                            .frame(width: 7, height: 7)
                            .position(point(last))
                            .widgetAccentable()
                    }
                }
            }
        }
    }

    private static func addConnector(to path: inout Path, from start: CGPoint, to end: CGPoint) {
        let dx = end.x - start.x
        let dy = end.y - start.y
        let distance = (dx * dx + dy * dy).squareRoot()
        guard distance > shortestConnector else { return }
        let inset = connectorInset / distance
        path.move(to: CGPoint(x: start.x + dx * inset, y: start.y + dy * inset))
        path.addLine(to: CGPoint(x: end.x - dx * inset, y: end.y - dy * inset))
    }

    /// Colours by range only in full colour on the face; a tile's background already carries the state.
    private var showsRanges: Bool { renderingMode == .fullColor && !onTile && !stale }

    /// One gradient with hard stops at the ranges' heights, relative to the chart's frame.
    private func lineStyle(y: (Double) -> CGFloat, height: CGFloat) -> AnyShapeStyle {
        guard showsRanges, height > 0 else { return singleColor }
        let veryHigh = y(250) / height
        let high = y(180) / height
        let low = y(70) / height
        return AnyShapeStyle(LinearGradient(stops: [
            .init(color: WatchPalette.alarm, location: 0),
            .init(color: WatchPalette.alarm, location: veryHigh),
            .init(color: WatchPalette.high, location: veryHigh),
            .init(color: WatchPalette.high, location: high),
            .init(color: WatchPalette.inRange, location: high),
            .init(color: WatchPalette.inRange, location: low),
            .init(color: WatchPalette.alarm, location: low),
            .init(color: WatchPalette.alarm, location: 1),
        ], startPoint: .top, endPoint: .bottom))
    }

    private func lineStyle(for value: Double) -> AnyShapeStyle {
        guard showsRanges else { return singleColor }
        switch WatchReading.level(of: Int(value)) {
        case .inRange: return AnyShapeStyle(WatchPalette.inRange)
        case .high: return AnyShapeStyle(WatchPalette.high)
        case .low, .veryHigh, .urgentLow: return AnyShapeStyle(WatchPalette.alarm)
        }
    }

    private var singleColor: AnyShapeStyle {
        AnyShapeStyle(stale ? Color.white.opacity(0.45) : lineColor)
    }
}
