import SwiftUI
import GlucoMindCore
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

/// Ustawienia → Zgłoś problem: one file with what the phone and the server recorded, read by the person before it goes
/// anywhere. Nothing is sent by the app: the share sheet is the only way out.
struct DiagnosticReportView: View {
    private struct PreparedReport: Equatable {
        let text: String
        let file: URL
        let note: String?
    }

    let apiClient: APIClient
    let patients: Int
    let remoteSetupComplete: Bool
    let deviceSignIn: Bool

    @State private var report: PreparedReport?
    @State private var preparing = false
    @State private var failed = false
    @State private var showingText = false

    var body: some View {
        List {
            Section {
                Text("Raport pomaga znaleźć przyczynę błędu. Aplikacja sama go nigdzie nie wysyła: to Ty decydujesz, czy i komu go przekazać.")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section("Co jest w raporcie") {
                Text("Wersje aplikacji i serwera, ustawienia techniczne, kody błędów oraz nazwy i godziny zdarzeń, na przykład że wysłano przypomnienie albo polecenie bolusa.")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section("Czego w nim nie ma") {
                Text("Imion, glukozy, dawek, posiłków, rozmów, zdjęć, kluczy, adresu serwera ani adresu Nightscouta.")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let report {
                Section {
                    Button {
                        showingText = true
                    } label: {
                        SettingsRowLabel(title: "Pokaż treść raportu", systemImage: "doc.text.fill", tint: SettingsColor.manual)
                    }
                    .accessibilityIdentifier("report.show")
                    ShareLink(item: report.file) {
                        SettingsRowLabel(title: "Udostępnij plik", systemImage: "square.and.arrow.up.fill", tint: SettingsColor.manual)
                    }
                    .accessibilityIdentifier("report.share")
                    Link(destination: SettingsLinks.issues) {
                        HStack {
                            SettingsRowLabel(title: "Otwórz zgłoszenia na GitHubie", systemImage: "exclamationmark.bubble.fill", tint: SettingsColor.manual)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .accessibilityIdentifier("report.issues")
                } header: {
                    Text("Gotowe")
                } footer: {
                    Text((report.note.map { "\($0) " } ?? "") + "Zgłoszenia na GitHubie są publiczne. Przeczytaj raport, zanim go tam dodasz.")
                }
            }
            Section {
                Button {
                    Task { await prepare() }
                } label: {
                    HStack {
                        Text(report == nil ? "Przygotuj raport" : "Przygotuj raport jeszcze raz")
                        Spacer()
                        if preparing { ProgressView() }
                    }
                }
                .disabled(preparing)
                .accessibilityIdentifier("report.prepare")
            } footer: {
                if failed {
                    Text("Nie udało się zapisać pliku z raportem. Spróbuj jeszcze raz.")
                }
            }
        }
        .settingsListStyle()
        .navigationTitle("Zgłoś problem")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .sheet(isPresented: $showingText) {
            if let report {
                NavigationStack {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(report.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                                Text(line.isEmpty ? " " : line)
                                    .font(.caption2.monospaced())
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding()
                    }
                    .navigationTitle("Treść raportu")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Zamknij") { showingText = false }
                        }
                    }
                }
            }
        }
    }

    private func prepare() async {
        preparing = true
        failed = false
        defer { preparing = false }
        let server: DiagnosticServerPart
        do {
            server = .report(try await apiClient.getDiagnosticReport().text)
        } catch {
            server = DiagnosticServerPart(error: error)
        }
        let now = Date()
        let text = DiagnosticReportText.build(now: now, facts: await phoneFacts(now: now), entries: DiagnosticLog.shared.entries(), server: server)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(DiagnosticReportText.fileName(now: now))
        do {
            try text.write(to: file, atomically: true, encoding: .utf8)
            report = PreparedReport(text: text, file: file, note: server.screenNote)
        } catch {
            failed = true
        }
    }

    private func phoneFacts(now: Date) async -> DiagnosticPhoneFacts {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        #if canImport(UIKit)
        let systemVersion = UIDevice.current.systemVersion
        let backgroundRefresh = Self.text(UIApplication.shared.backgroundRefreshStatus)
        let registered = UIApplication.shared.isRegisteredForRemoteNotifications
        #else
        let systemVersion = ProcessInfo.processInfo.operatingSystemVersionString
        let backgroundRefresh = "unknown"
        let registered = false
        #endif
        return DiagnosticPhoneFacts(
            appVersion: AppBuildInfo.current.displayText,
            deviceModel: model,
            systemVersion: systemVersion,
            timeZone: TimeZone.current.identifier,
            utcOffsetMinutes: TimeZone.current.secondsFromGMT(for: now) / 60,
            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
            backgroundRefresh: backgroundRefresh,
            notificationAuthorization: Self.text(settings.authorizationStatus),
            notificationAlerts: Self.text(settings.alertSetting),
            notificationSounds: Self.text(settings.soundSetting),
            registeredForPushes: registered,
            deviceSignIn: deviceSignIn,
            patients: patients,
            remoteSetupComplete: remoteSetupComplete
        )
    }

    private static func text(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "nieustalona"
        case .denied: return "brak"
        case .authorized: return "jest"
        case .provisional: return "tymczasowa"
        case .ephemeral: return "chwilowa"
        @unknown default: return "nieznana"
        }
    }

    private static func text(_ setting: UNNotificationSetting) -> String {
        switch setting {
        case .enabled: return "włączone"
        case .disabled: return "wyłączone"
        case .notSupported: return "nieobsługiwane"
        @unknown default: return "nieznane"
        }
    }

    #if canImport(UIKit)
    private static func text(_ status: UIBackgroundRefreshStatus) -> String {
        switch status {
        case .available: return "włączone"
        case .denied: return "wyłączone"
        case .restricted: return "ograniczone"
        @unknown default: return "nieznane"
        }
    }
    #endif
}
