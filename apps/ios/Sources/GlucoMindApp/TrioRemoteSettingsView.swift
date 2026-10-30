import SwiftUI
import UniformTypeIdentifiers
import GlucoMindCore
#if os(iOS)
import UIKit
#endif

/// Remote control of one patient's Trio (variant A, 2026-10-19): the state on top, then one card per step; done steps
/// fold to a line and the next step to do is open. Everything typed is saved as it changes, in this phone's Keychain.
struct TrioRemoteSettingsView: View {
    @StateObject private var viewModel: TrioRemoteSettingsViewModel
    /// Which key the file picker fills; kept after the picker closes (it reports the file after it closed).
    @State private var importSlot: KeySlot = .trio
    @State private var isImporterPresented = false
    @State private var importError: String?
    @State private var importedFile: [KeySlot: String] = [:]
    @State private var isClearConfirmationPresented = false
    /// The card the caregiver opened; nil follows the next step to do (unless every card was folded).
    @State private var expanded: TrioSetupStep?
    @State private var foldedAll = false
    @State private var editsKeyIDByHand: Set<KeySlot> = []

    private enum KeySlot: Hashable {
        case trio, glucoMind
    }

    init(viewModel: @autoclosure @escaping () -> TrioRemoteSettingsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    private var openStep: TrioSetupStep? { foldedAll ? nil : (expanded ?? viewModel.nextStep) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                statusCard
                ForEach(viewModel.steps) { step in
                    stepCard(step)
                }
                Label("Klucze i sekret zostają w pęku kluczy tego telefonu i zapisują się same.", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                if let saveError = viewModel.saveError {
                    Label(saveError, systemImage: "exclamationmark.octagon.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 4)
                }
                emergencySection
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(DashboardPalette.pageBackground)
        .navigationTitle("Zdalne sterowanie")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await viewModel.refreshTarget()
        }
        .refreshable {
            await viewModel.refreshTarget()
        }
        .fileImporter(isPresented: $isImporterPresented, allowedContentTypes: [UTType(filenameExtension: "p8") ?? .data, .data]) { result in
            switch result {
            case .success(let url):
                importKey(from: url, into: importSlot)
            case .failure:
                importError = "Nie udało się otworzyć pliku."
            }
        }
        .animation(.easeInOut(duration: 0.2), value: openStep)
    }

    // MARK: Status

    @ViewBuilder
    private var statusCard: some View {
        if viewModel.isReady {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.green)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.green.opacity(0.18)))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Gotowe do wysyłania").font(.headline)
                    Text(readyLine).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.green.opacity(0.12)))
        } else {
            let total = viewModel.steps.count
            let done = viewModel.doneCount
            HStack(spacing: 12) {
                ZStack {
                    Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 6)
                    Circle()
                        .trim(from: 0, to: total > 0 ? CGFloat(done) / CGFloat(total) : 0)
                        .stroke(Color.green, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Text("\(done)/\(total)").font(.subheadline.weight(.bold).monospacedDigit())
                }
                .frame(width: 54, height: 54)
                VStack(alignment: .leading, spacing: 3) {
                    Text(total - done == 1 ? "Jeszcze 1 krok" : "Jeszcze \(total - done) kroki").font(.headline)
                    Text("Potem możesz wysyłać polecenia do Trio\(viewModel.patientName.map { " pacjenta \($0)" } ?? "").")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(card)
        }
    }

    private var readyLine: String {
        var line = "Polecenia z zakładki Bolus, z rozmowy i z okna WBT idą do Trio\(viewModel.patientName.map { " pacjenta \($0)" } ?? "")."
        if let last = viewModel.lastCommand, let at = ServerDate.parse(last.sent_at ?? last.authorized_at) {
            line += " Ostatnie polecenie: \(RemoteCommandFormat.time(at)), \((last.status_message ?? last.status).lowercased())."
        }
        return line
    }

    // MARK: Steps

    private func stepCard(_ step: TrioSetupStep) -> some View {
        let isOpen = openStep == step
        return RemoteSetupStepCard(
            number: (viewModel.steps.firstIndex(of: step) ?? 0) + 1,
            title: title(step),
            summary: summary(step),
            done: viewModel.isDone(step),
            isOpen: isOpen,
            problem: step == .trio && (viewModel.pin == .changed || viewModel.pin == .usedByOtherPatient),
            dimmed: viewModel.nextStep != step,
            onToggle: {
                if isOpen {
                    foldedAll = true
                    expanded = nil
                } else {
                    foldedAll = false
                    expanded = step
                }
            },
            content: { content(step) }
        )
    }

    private func title(_ step: TrioSetupStep) -> String {
        switch step {
        case .trio: return "Trio w Nightscout"
        case .secret: return "Shared Secret"
        case .key: return "Klucz Apple (APNs)"
        case .returnKey: return "Klucz do odpowiedzi Trio"
        case .limits: return "Limity na tym telefonie"
        }
    }

    /// The folded card's line.
    private func summary(_ step: TrioSetupStep) -> String? {
        switch step {
        case .trio:
            switch viewModel.pin {
            case .confirmed:
                return [viewModel.target?.apns_environment == "production" ? "TestFlight" : "Xcode", buildExpiry].compactMap { $0 }.joined(separator: " · ")
            case .needsConfirmation: return "Połączone"
            case .changed: return "Nightscout pokazuje inne Trio: potwierdź je"
            case .usedByOtherPatient: return "To Trio jest przypisane do innego pacjenta"
            case .notReady: return viewModel.targetError ?? viewModel.target?.summary ?? "Sprawdzam…"
            }
        case .secret:
            return viewModel.isDone(.secret) ? "Zapisany ••••••" : "Z Trio na telefonie pacjenta"
        case .key:
            return viewModel.isDone(.key) ? "Key ID \(viewModel.settings.apnsKeyID)" : "Plik .p8 konta, które zbudowało Trio"
        case .returnKey:
            return viewModel.isDone(.returnKey) ? "Key ID \(viewModel.settings.returnKeyID ?? "")" : "Plik .p8 konta aplikacji Mellis (\(viewModel.identity.teamID))"
        case .limits:
            if !viewModel.isDone(.limits) { return "Sprawdź limity dla tego pacjenta" }
            let step = viewModel.pumpBolusStep.map { "krok \(RemoteCommandFormat.units($0)) j (z Trio)" } ?? "krok \(RemoteCommandFormat.units(viewModel.settings.bolusIncrement)) j"
            return "Bolus do \(RemoteCommandFormat.units(viewModel.settings.maxBolusUnits)) j · węgle do \(viewModel.settings.maxCarbsGrams) g · \(step)"
        }
    }

    private var patientSuffix: String { viewModel.patientName.map { " pacjenta \($0)" } ?? " tego pacjenta" }

    private var buildExpiry: String? {
        viewModel.target?.build_expires_at.flatMap(ServerDate.parse).map { "build ważny do \($0.formatted(.dateTime.day().month(.abbreviated)))" }
    }

    @ViewBuilder
    private func content(_ step: TrioSetupStep) -> some View {
        switch step {
        case .trio: trioContent
        case .secret: secretContent
        case .key: keyContent(slot: .trio)
        case .returnKey: keyContent(slot: .glucoMind)
        case .limits: limitsContent
        }
    }

    // MARK: Trio

    @ViewBuilder
    private var trioContent: some View {
        if viewModel.isLoading && viewModel.target == nil {
            ProgressView()
        } else if let error = viewModel.targetError {
            Label(error, systemImage: "wifi.exclamationmark").font(.subheadline).foregroundStyle(.red)
        } else if let target = viewModel.target {
            switch viewModel.pin {
            case .notReady:
                Label(target.summary, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange)
            case .needsConfirmation, .confirmed:
                Label("Trio\(patientSuffix) jest w Nightscout i przyjmuje polecenia zdalne.", systemImage: "checkmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.green)
                Text("Polecenia z tego profilu pójdą tylko do tego Trio. Gdy Nightscout pokaże kiedyś inne Trio, zapytam, zanim cokolwiek wyślę.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .changed:
                Label("Nightscout\(patientSuffix) pokazuje inne Trio niż przy konfiguracji. Tak się dzieje po nowej instalacji Trio albo zmianie telefonu, ale też przy pomyłce w Nightscout. Do potwierdzenia nic nie zostanie wysłane.", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                confirmTrioButton("To nowe Trio\(patientSuffix)")
            case .usedByOtherPatient:
                Label("To samo Trio jest na tym telefonie przypisane do innego pacjenta. Sprawdź, czy Nightscout tego pacjenta jest właściwy: polecenia stąd nie zostaną wysłane. Jeśli tamtego pacjenta nie ma już na serwerze (np. po ponownej instalacji serwera), otwórz Mellis z dostępem do sieci: stare ustawienia znikną same po wczytaniu listy pacjentów.", systemImage: "xmark.octagon.fill")
                    .font(.subheadline)
                    .foregroundStyle(.red)
            }
            DisclosureGroup("Szczegóły") {
                VStack(alignment: .leading, spacing: 6) {
                    if let team = target.team_id { LabeledContent("Konto Apple Trio", value: team) }
                    if let environment = target.apns_environment {
                        LabeledContent("Środowisko", value: environment == "production" ? "produkcyjne (TestFlight)" : "deweloperskie (Xcode)")
                    }
                    if let uploaded = target.profile_uploaded_at.flatMap(ServerDate.parse) {
                        LabeledContent("Profil wysłany", value: RemoteCommandFormat.dayAndTime(uploaded))
                    }
                    if let expires = target.build_expires_at.flatMap(ServerDate.parse) {
                        LabeledContent("Build Trio ważny do", value: RemoteCommandFormat.day(expires))
                    }
                }
                .font(.footnote)
                .padding(.top, 6)
            }
            .font(.subheadline)
        }
    }

    private func confirmTrioButton(_ title: String) -> some View {
        Button {
            viewModel.confirmTrio()
            expanded = nil
            foldedAll = false
        } label: {
            Label(title, systemImage: "checkmark.seal")
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }

    // MARK: Shared Secret

    @ViewBuilder
    private var secretContent: some View {
        HStack(spacing: 8) {
            SecureField("Shared Secret", text: $viewModel.settings.sharedSecret)
                .textContentType(.password)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.secondary.opacity(0.12)))
            #if os(iOS)
            Button {
                if let pasted = UIPasteboard.general.string { viewModel.settings.sharedSecret = pasted }
            } label: {
                Label("Wklej", systemImage: "doc.on.clipboard")
            }
            .buttonStyle(.bordered)
            #endif
        }
        if viewModel.secretUsedByOtherPatient {
            Label(TrioPatientGuard.secretMessage, systemImage: "xmark.octagon.fill").font(.footnote).foregroundStyle(.red)
        }
        Text("Z Trio na telefonie pacjenta: Ustawienia → Remote Control. Każde Trio musi mieć własny sekret.")
            .font(.footnote)
            .foregroundStyle(.secondary)
    }

    // MARK: Keys

    @ViewBuilder
    private func keyContent(slot: KeySlot) -> some View {
        let keyID = slot == .trio ? viewModel.settings.apnsKeyID : (viewModel.settings.returnKeyID ?? "")
        let p8 = slot == .trio ? viewModel.settings.apnsKeyP8 : (viewModel.settings.returnKeyP8 ?? "")
        if p8.isEmpty {
            Button {
                openImporter(for: slot)
            } label: {
                Label("Wczytaj plik .p8", systemImage: "doc.badge.arrow.up")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(importedFile[slot] ?? "Klucz wczytany").font(.subheadline.weight(.semibold))
                    Text(APNsAuthToken.isKeyID(keyID) ? "Key ID \(keyID)\(importedFile[slot] != nil && !editsKeyIDByHand.contains(slot) ? " · odczytany z nazwy pliku" : "")" : "Brakuje Key ID")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Button("Zmień") { openImporter(for: slot) }.font(.subheadline)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.green.opacity(0.1)))
        }
        if editsKeyIDByHand.contains(slot) || (!p8.isEmpty && !APNsAuthToken.isKeyID(keyID)) {
            TextField("Key ID (10 znaków)", text: keyIDBinding(slot))
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.characters)
                #endif
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.secondary.opacity(0.12)))
        } else if p8.isEmpty {
            HStack {
                Label("Key ID", systemImage: "number")
                Spacer()
                Text("uzupełni się z pliku").font(.footnote)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.secondary.opacity(0.12)))
        }
        if let importError {
            Label(importError, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
        }
        Text(slot == .trio
             ? "Apple nazywa plik AuthKey_XXXXXXXXXX.p8: Key ID odczytam z nazwy. Plik pobierzesz z developer.apple.com → Keys (Apple Push Notifications service), z konta, które zbudowało Trio."
             : "Trio jest zbudowane na innym koncie Apple niż Mellis (\(viewModel.identity.teamID)). Tym kluczem Trio odpowie na polecenie.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        if !editsKeyIDByHand.contains(slot) {
            Button("Wpisz Key ID ręcznie") { editsKeyIDByHand.insert(slot) }
                .font(.footnote)
        }
    }

    private func keyIDBinding(_ slot: KeySlot) -> Binding<String> {
        switch slot {
        case .trio:
            return Binding(get: { viewModel.settings.apnsKeyID }, set: { viewModel.settings.apnsKeyID = $0.uppercased() })
        case .glucoMind:
            return Binding(get: { viewModel.settings.returnKeyID ?? "" }, set: { viewModel.settings.returnKeyID = $0.isEmpty ? nil : $0.uppercased() })
        }
    }

    // MARK: Limits

    @ViewBuilder
    private var limitsContent: some View {
        Stepper(value: Binding(
            get: { NSDecimalNumber(decimal: viewModel.settings.maxBolusUnits).doubleValue },
            set: { viewModel.settings.maxBolusUnits = Decimal(($0 * 2).rounded() / 2) }
        ), in: 0.5...30, step: 0.5) {
            LabeledContent("Maksymalny bolus", value: "\(RemoteCommandFormat.units(viewModel.settings.maxBolusUnits)) j")
        }
        Stepper(value: $viewModel.settings.maxCarbsGrams, in: 5...300, step: 5) {
            LabeledContent("Maksymalne węglowodany", value: "\(viewModel.settings.maxCarbsGrams) g")
        }
        if let pumpStep = viewModel.pumpBolusStep {
            LabeledContent("Krok pompy") {
                Label("\(RemoteCommandFormat.units(pumpStep)) j · z Trio", systemImage: "arrow.triangle.2.circlepath")
                    .foregroundStyle(.secondary)
            }
        } else {
            Picker("Krok pompy", selection: $viewModel.settings.bolusIncrement) {
                Text("0,05 j").tag(Decimal(string: "0.05")!)
                Text("0,1 j").tag(Decimal(string: "0.1")!)
            }
        }
        Text(viewModel.pumpBolusStep == nil
             ? "Nie luźniej niż w Trio, inaczej Trio odrzuci polecenie. Trio nie podaje kroku pompy: wybierz go tutaj."
             : "Nie luźniej niż w Trio, inaczej Trio odrzuci polecenie.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        // Opening the card is not checking it: the caregiver says the limits fit this patient.
        // dose-calculator.v1 (owner 2026-10-29): the limits are checked on purpose before anything is sent; the
        // defaults (5 j, 100 g) are said to be defaults, and the button names the values it confirms.
        if !viewModel.isDone(.limits) {
            if viewModel.settings.maxBolusUnits == 5 && viewModel.settings.maxCarbsGrams == 100 {
                Label("To wartości domyślne. Ustaw je dla tego pacjenta: zwykle największa dawka i największy posiłek, jakie podajesz zdalnie.", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        if !viewModel.isDone(.limits) {
            Button {
                viewModel.markLimitsReviewed()
                expanded = nil
                foldedAll = false
            } label: {
                Label("Potwierdzam: bolus do \(RemoteCommandFormat.units(viewModel.settings.maxBolusUnits)) j, węgle do \(viewModel.settings.maxCarbsGrams) g", systemImage: "checkmark")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    // MARK: Emergency

    private var emergencySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("AWARYJNIE").font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 4).padding(.top, 10)
            if viewModel.hasStoredSettings {
                Button(role: .destructive) {
                    isClearConfirmationPresented = true
                } label: {
                    Label("Usuń ustawienia z tego telefonu", systemImage: "trash")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .confirmationDialog("Usunąć ustawienia Trio z tego telefonu?", isPresented: $isClearConfirmationPresented, titleVisibility: .visible) {
                    Button("Usuń", role: .destructive) {
                        viewModel.clear()
                        importedFile = [:]
                        expanded = nil
                        foldedAll = false
                    }
                    Button("Anuluj", role: .cancel) {}
                }
                .padding(14)
                .background(card)
            }
            Text("Wyłączenie Remote Control w Trio (albo zmiana Shared Secret) zatrzymuje każde polecenie, także z tego telefonu.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
        }
    }

    private var card: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous).fill(DashboardPalette.cardBackground)
    }

    // MARK: Import

    private func openImporter(for slot: KeySlot) {
        importSlot = slot
        importError = nil
        isImporterPresented = true
    }

    private func importKey(from url: URL, into slot: KeySlot) {
        let key: APNsKeyFile.Key
        switch APNsKeyFile.read(url) {
        case let .success(read): key = read
        case let .failure(error):
            importError = error.message
            return
        }
        importError = nil
        // A new file is a new key: its id (from Apple's file name) replaces the one typed before.
        importedFile[slot] = url.lastPathComponent
        if key.keyID != nil { editsKeyIDByHand.remove(slot) } else { editsKeyIDByHand.insert(slot) }
        switch slot {
        case .trio:
            viewModel.settings.apnsKeyP8 = key.pem
            if let keyID = key.keyID { viewModel.settings.apnsKeyID = keyID }
        case .glucoMind:
            viewModel.settings.returnKeyP8 = key.pem
            if let keyID = key.keyID { viewModel.settings.returnKeyID = keyID }
        }
    }

}
