import SwiftUI
import GlucoMindCore

/// Ustawienia → "Ten telefon" → "Linia prognozy": this phone's own switch for the forecast line on the charts, on by default.
struct PredictionLineToggleRow: View {
    @AppStorage(PredictionLinePreference.key) private var lineShown = PredictionLinePreference.defaultShown

    var body: some View {
        Toggle(isOn: $lineShown) {
            HStack(spacing: 14) {
                SettingsIcon("chart.line.uptrend.xyaxis", tint: SettingsColor.patient)
                VStack(alignment: .leading, spacing: 4) {
                    Text(PredictionLineText.title).foregroundStyle(Color.primary)
                    Text(PredictionLineText.detail)
                        .font(.footnote)
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
        }
        .tint(Brand.interactive)
        .accessibilityIdentifier("settings.predictionLine.toggle")
    }
}
