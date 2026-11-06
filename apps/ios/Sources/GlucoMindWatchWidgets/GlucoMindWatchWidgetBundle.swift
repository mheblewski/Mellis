import SwiftUI
import WidgetKit

/// WidgetKit pushes exist from watchOS 26. A WidgetBundle's body cannot branch on the system version, so each version
/// gets its own bundle; the kinds are the same, so complications on the face survive a system update. Before watchOS 26
/// the complications reload only on their own timeline, which watchOS schedules.
@main
enum GlucoMindWatchWidgetEntry {
    static func main() {
        if #available(watchOS 26.0, *) {
            PushedComplicationsBundle.main()
        } else {
            ScheduledComplicationsBundle.main()
        }
    }
}

struct ScheduledComplicationsBundle: WidgetBundle {
    var body: some Widget {
        GlucoseComplication()
        SecondPatientGlucoseComplication()
        GlucosePairComplication()
        GlucosePairColumnsComplication()
    }
}

@available(watchOS 26.0, *)
struct PushedComplicationsBundle: WidgetBundle {
    var body: some Widget {
        PushedGlucoseComplication()
        PushedSecondPatientGlucoseComplication()
        PushedGlucosePairComplication()
        PushedGlucosePairColumnsComplication()
    }
}

/// One patient: circular, corner, rectangular (also the Smart Stack tile) and inline. Two complications, the first and
/// the second patient of the caregiver's list, each named after its patient in the face editor ("Glukoza · Ania").
struct GlucoseComplication: Widget {
    static let kind = "GlucoMindWatchGlucose"

    var body: some WidgetConfiguration {
        patientComplication(kind: Self.kind, index: 0)
    }
}

struct SecondPatientGlucoseComplication: Widget {
    static let kind = "GlucoMindWatchGlucose2"

    var body: some WidgetConfiguration {
        patientComplication(kind: Self.kind, index: 1)
    }
}

@available(watchOS 26.0, *)
struct PushedGlucoseComplication: Widget {
    var body: some WidgetConfiguration {
        patientComplication(kind: GlucoseComplication.kind, index: 0)
            .pushHandler(WatchWidgetPushHandler.self)
    }
}

@available(watchOS 26.0, *)
struct PushedSecondPatientGlucoseComplication: Widget {
    var body: some WidgetConfiguration {
        patientComplication(kind: SecondPatientGlucoseComplication.kind, index: 1)
            .pushHandler(WatchWidgetPushHandler.self)
    }
}

private func patientComplication(kind: String, index: Int) -> some WidgetConfiguration {
    let patients = WatchSession.usesFixtures ? [WatchSample.first, WatchSample.second] : WatchCache.patients
    let name = patients.indices.contains(index) ? patients[index].name : (index == 0 ? "pierwsza osoba" : "druga osoba")
    // A String on purpose: WidgetKit traps on an interpolated LocalizedStringKey here ("Formatted text is not supported"),
    // and with the extension dead the face editor keeps its old list and the complications show no values.
    let title: String = "Glukoza · \(name)"
    return StaticConfiguration(kind: kind, provider: WatchIndexProvider(index: index)) { entry in
        GlucoseComplicationView(entry: entry)
    }
    .configurationDisplayName(title)
    .description("Glukoza, strzałka trendu i wiek odczytu.")
    .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
}

/// Two patients in one complication: rectangular (two rows; two tiles in the Smart Stack) and inline.
struct GlucosePairComplication: Widget {
    static let kind = "GlucoMindWatchPair"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: WatchPairProvider()) { entry in
            GlucosePairComplicationView(entry: entry)
        }
        .configurationDisplayName("Dwie osoby")
        .description("Glukoza dwóch pierwszych osób z Twojej listy.")
        .supportedFamilies([.accessoryRectangular, .accessoryInline])
        .contentMarginsDisabled()
    }
}

@available(watchOS 26.0, *)
struct PushedGlucosePairComplication: Widget {
    var body: some WidgetConfiguration {
        GlucosePairComplication().body
            .pushHandler(WatchWidgetPushHandler.self)
    }
}

/// Two patients side by side, a choice next to the two rows: rectangular only (a line has no columns).
struct GlucosePairColumnsComplication: Widget {
    static let kind = "GlucoMindWatchPairColumns"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: WatchPairProvider()) { entry in
            GlucosePairColumnsComplicationView(entry: entry)
        }
        .configurationDisplayName("Dwie osoby, kolumny")
        .description("Glukoza dwóch pierwszych osób z Twojej listy, obok siebie.")
        .supportedFamilies([.accessoryRectangular])
        .contentMarginsDisabled()
    }
}

@available(watchOS 26.0, *)
struct PushedGlucosePairColumnsComplication: Widget {
    var body: some WidgetConfiguration {
        GlucosePairColumnsComplication().body
            .pushHandler(WatchWidgetPushHandler.self)
    }
}

struct GlucoseComplicationView: View {
    let entry: WatchComplicationEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            CircularComplication(content: entry.first, initial: entry.initial(of: entry.first), now: entry.date)
                .containerBackground(for: .widget) { Color.clear }
        case .accessoryCorner:
            CornerComplication(content: entry.first, initial: entry.initial(of: entry.first), now: entry.date)
                .containerBackground(for: .widget) { Color.clear }
        case .accessoryInline:
            InlineComplication(content: entry.first, now: entry.date)
                .containerBackground(for: .widget) { Color.clear }
        default:
            // Sets its own background: the state-coloured tile in the Smart Stack.
            RectangularComplication(content: entry.first, now: entry.date)
        }
    }
}

struct GlucosePairComplicationView: View {
    let entry: WatchComplicationEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryInline:
            InlinePairComplication(first: entry.first, second: entry.second, initials: entry.initials, now: entry.date)
                .containerBackground(for: .widget) { Color.clear }
        default:
            if entry.contents.count < 2 {
                // One patient only: the one-patient layout instead of an empty second row.
                RectangularComplication(content: entry.first, now: entry.date).padding(.horizontal, 2)
            } else {
                RectangularPairComplication(first: entry.first, second: entry.second, now: entry.date)
            }
        }
    }
}

struct GlucosePairColumnsComplicationView: View {
    let entry: WatchComplicationEntry

    var body: some View {
        if entry.contents.count < 2 {
            // One patient only: the one-patient layout instead of an empty column.
            RectangularComplication(content: entry.first, now: entry.date).padding(.horizontal, 2)
        } else {
            RectangularPairColumnsComplication(first: entry.first, second: entry.second, now: entry.date)
        }
    }
}
