import SwiftUI
import GlucoMindCore

/// Asked before the tabs open while the patient has no year of birth: the AI states the patient's age from it (portions,
/// therapy suggestions, answers) instead of assuming a child.
struct PatientBirthYearRequiredView: View {
    let patientName: String
    let onSave: (Int) async throws -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        Image("LogoLarge")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 64, height: 64)
                            .accessibilityHidden(true)
                        Text(patientName)
                            .font(.title3.weight(.semibold))
                        Text("Podaj rok urodzenia. Mellis dopasuje do wieku porcje, sugestie i odpowiedzi.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
                PatientBirthYearFields(birthYear: nil, onSave: onSave)
            }
            .navigationTitle("Rok urodzenia")
        }
    }
}

/// "Rok urodzenia" in the settings.
struct PatientBirthYearEditView: View {
    let patientName: String?
    let birthYear: Int?
    let onSave: (Int) async throws -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            PatientBirthYearFields(birthYear: birthYear) { year in
                try await onSave(year)
                dismiss()
            }
        }
        .navigationTitle("Rok urodzenia")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// The year typed in four digits and "Zapisz"; a wrong year or a failed save is said under the field.
private struct PatientBirthYearFields: View {
    let birthYear: Int?
    let onSave: (Int) async throws -> Void

    @State private var text = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var isFocused: Bool

    private var parsed: Int? { PatientBirthYear.parse(text) }

    var body: some View {
        Section {
            TextField("Np. 2015", text: $text)
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .focused($isFocused)
                .disabled(isSaving)
                .onChange(of: text) { _, _ in errorMessage = nil }
        } footer: {
            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
            } else if text.count == 4, parsed == nil {
                Text("Wpisz rok od \(PatientBirthYear.earliest) do bieżącego.")
                    .foregroundStyle(.red)
            }
        }
        Section {
            Button {
                guard let year = parsed else { return }
                isSaving = true
                Task {
                    do {
                        try await onSave(year)
                    } catch {
                        errorMessage = "Nie udało się zapisać. Sprawdź połączenie i spróbuj ponownie."
                    }
                    isSaving = false
                }
            } label: {
                HStack {
                    Spacer()
                    if isSaving {
                        ProgressView()
                    } else {
                        Text("Zapisz").fontWeight(.semibold)
                    }
                    Spacer()
                }
            }
            .disabled(parsed == nil || parsed == birthYear || isSaving)
        }
        .onAppear {
            text = birthYear.map(String.init) ?? ""
            isFocused = true
        }
    }
}
