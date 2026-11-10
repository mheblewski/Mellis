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

/// Ustawienia → pacjent → "Funkcje eksperymentalne": the switch of the glucose prediction (owners only). It goes on and
/// off at once, with no notice: it does not touch doses or alerts.
struct PredictionExperimentSettingsSection: View {
    let patient: AccessiblePatient
    let apiClient: APIClient
    let access: PredictionExperimentAccess
    /// False when a section above already shows the "Funkcje eksperymentalne" header.
    let showsHeader: Bool
    /// The server confirmed the new state.
    let onChanged: (Bool) -> Void

    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var copiedComparison = false

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { access.enabled }, set: { wanted in
                Task { await save(wanted) }
            })) {
                HStack(spacing: 14) {
                    SettingsIcon("chart.line.uptrend.xyaxis", tint: BrandTint.amber)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(PredictionExperimentText.featureName).foregroundStyle(Color.primary)
                        Text(PredictionExperimentText.detail)
                            .font(.footnote)
                            .foregroundStyle(Color.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            .tint(Brand.interactive)
            .disabled(isSaving)
            .accessibilityIdentifier("settings.prediction.toggle")
            if let errorMessage {
                SettingsErrorRow(message: errorMessage)
            }
            if access.enabled, let comparison = access.low_comparison {
                comparisonRows(comparison)
            }
        } header: {
            if showsHeader { Text(PredictionExperimentText.settingsSection) }
        } footer: {
            Text(PredictionExperimentText.footer)
        }
    }

    /// The two ways of warning about a low, side by side: what is being collected, then the result with a request to pass it on.
    @ViewBuilder
    private func comparisonRows(_ comparison: LowWarningComparison) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(LowWarningComparisonText.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.primary)
            ForEach(comparison.ready ? LowWarningComparisonText.result(comparison) : LowWarningComparisonText.collecting(comparison), id: \.self) { line in
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if comparison.ready {
                Text(LowWarningComparisonText.passOn)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.prediction.lowComparison")
        if comparison.ready {
            Button(copiedComparison ? LowWarningComparisonText.copied : LowWarningComparisonText.copy) {
                copyToPasteboard(LowWarningComparisonText.share(comparison))
                copiedComparison = true
            }
            .tint(Brand.interactive)
            .accessibilityIdentifier("settings.prediction.lowComparison.copy")
        }
    }

    private func save(_ enabled: Bool) async {
        isSaving = true
        defer { isSaving = false }
        do {
            let response = try await apiClient.setPredictionExperiment(patientID: patient.patient_id, enabled: enabled)
            errorMessage = nil
            onChanged(response.enabled)
        } catch APIClientError.forbidden {
            errorMessage = "Tylko właściciel pacjenta może to zmienić, a serwer musi mieć tę funkcję włączoną."
        } catch {
            errorMessage = "Nie udało się zapisać. Spróbuj ponownie."
        }
    }
}
