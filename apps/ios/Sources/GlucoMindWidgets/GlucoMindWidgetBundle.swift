import GlucoMindCore
import SwiftUI
import WidgetKit

@main
struct GlucoMindWidgetBundle: WidgetBundle {
    var body: some Widget {
        GlucoMindHomeWidget()
        GlucoseLiveActivity()
    }
}

/// "Mellis" in the widget gallery: small, medium and large, each patient in its own widget.
struct GlucoMindHomeWidget: Widget {
    static let kind = "GlucoMindHome"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: SelectPatientIntent.self, provider: HomeWidgetProvider()) { entry in
            // The view sets its own container background (red wash on an alarm).
            HomeWidgetView(entry: entry)
        }
        .configurationDisplayName("Mellis")
        .description("Glukoza, wykres i sprzęt. Bolus otwiera zakładkę Bolus.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
