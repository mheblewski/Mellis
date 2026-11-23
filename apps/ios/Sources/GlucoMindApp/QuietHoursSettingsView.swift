import SwiftUI
import UserNotifications
import GlucoMindCore

/// "Godziny ciszy" (quiet-hours.v1, docs/product/quiet-hours-plan.md): this phone's hours without glucose pushes, for
/// every patient on it. Texts as agreed in the role review (docs/product/quiet-hours-review.md).
struct QuietHoursSettingsView: View {
    @ObservedObject var viewModel: QuietHoursViewModel
    @State private var introPresented = false
    @State private var timeSensitiveOff = false

    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { viewModel.settings.enabled }, set: { enabled in
                    if enabled && !QuietHoursStore.introShown() {
                        introPresented = true
                    } else {
                        Task { await viewModel.setEnabled(enabled) }
                    }
                })) {
                    SettingsRowLabel(title: "Godziny ciszy", systemImage: "moon.fill", tint: SettingsColor.notifications)
                }
                .tint(Brand.interactive)
                .disabled(!viewModel.isLoaded || viewModel.isSaving)
                .accessibilityIdentifier("quietHours.enabled")
                if viewModel.settings.enabled {
                    DatePicker("Od", selection: minuteBinding(\.start_minute) { minute in await viewModel.setStart(minute) }, displayedComponents: .hourAndMinute)
                        .accessibilityIdentifier("quietHours.start")
                    DatePicker(selection: minuteBinding(\.end_minute) { minute in await viewModel.setEnd(minute) }, displayedComponents: .hourAndMinute) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Do")
                            if viewModel.settings.endsNextDay {
                                Text("następnego dnia").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("quietHours.end")
                }
                if let errorMessage = viewModel.errorMessage {
                    SettingsErrorRow(message: errorMessage)
                }
            } footer: {
                Text("Działa tylko na tym telefonie, dla wszystkich osób. W tych godzinach Mellis nie wysyła powiadomień o glukozie ani o krótkich przerwach w odczytach. Alarmy muszą wtedy przyjść z aplikacji sensora, np. Dexcom Follow, włączonej na tym telefonie.")
            }

            if viewModel.settings.enabled {
                Section {
                    SettingsToggleRow(
                        title: "Ostrzeżenia o niedocukrzeniu",
                        detail: "Także w godzinach ciszy.",
                        systemImage: "exclamationmark.triangle.fill",
                        tint: SettingsColor.notifications,
                        isOn: Binding(get: { viewModel.settings.low_warnings }, set: { on in Task { await viewModel.setLowWarnings(on) } })
                    )
                    .disabled(!viewModel.isLoaded || viewModel.isSaving)
                    .accessibilityIdentifier("quietHours.lowWarnings")
                    if timeSensitiveOff {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Powiadomienia pilne są wyłączone w ustawieniach iOS. Tryb Sen może wyciszyć te ostrzeżenia.")
                                .font(.subheadline)
                            Button("Otwórz ustawienia") {
                                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } footer: {
                    Text(viewModel.settings.low_warnings
                        ? "Gdy glukoza spada albo jest niska, także poniżej 54, Mellis podpowie, ile węgli podać, i sprawdzi, czy pomogły. Przyjdzie też informacja o braku odczytów dłuższym niż godzina."
                        : "W godzinach ciszy Mellis powiadomi tylko o glukozie poniżej 54 utrzymującej się od 20 minut.")
                }

                Section {
                    Text("Pół godziny przed ciszą Mellis sprawdza zbiornik, baterię pompy i wkłucie. Jeśli coś może się skończyć przed końcem ciszy, powiadomienie przyjdzie wtedy. Reszta przyjdzie w jednym powiadomieniu zaraz po końcu ciszy.")
                        .font(.subheadline)
                } header: {
                    Text("Sprzęt i informacje")
                }

                Section {
                    Text("Bolusy i WBT, przypomnienia i odpowiedzi w rozmowach.")
                        .font(.subheadline)
                } header: {
                    Text("Zawsze przychodzą")
                }
            }
        }
        .settingsListStyle()
        .navigationTitle("Godziny ciszy")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await viewModel.load()
            await viewModel.syncTimeZone()
            timeSensitiveOff = await UNUserNotificationCenter.current().notificationSettings().timeSensitiveSetting == .disabled
        }
        .alert("Godziny ciszy", isPresented: $introPresented) {
            Button("Włącz") {
                QuietHoursStore.markIntroShown()
                Task { await viewModel.setEnabled(true) }
            }
            Button("Anuluj", role: .cancel) {}
        } message: {
            Text("W tych godzinach Mellis nie powiadomi o glukozie ani o krótkich przerwach w odczytach. Sprawdź, czy alarmy aplikacji sensora są włączone na tym telefonie.")
        }
    }

    /// A minute of the day as a time for the picker; a change is saved when the picker settles on it.
    private func minuteBinding(_ keyPath: KeyPath<QuietHoursSettings, Int>, save: @escaping (Int) async -> Void) -> Binding<Date> {
        Binding(
            get: {
                let minute = viewModel.settings[keyPath: keyPath]
                return Calendar.current.date(bySettingHour: minute / 60, minute: minute % 60, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
                guard minute != viewModel.settings[keyPath: keyPath] else { return }
                Task { await save(minute) }
            }
        )
    }
}
