import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import GlucoMindCore
#if os(iOS)
import UIKit
#if canImport(VisionKit)
import VisionKit
#endif
#endif

/// Remote control of one patient's Loop, in the layout of Trio's (TrioRemoteSettingsView): the state on top, then one
/// card per step; done steps fold to a line and the next step to do is open. Saved as typed, in this phone's Keychain.
struct LoopRemoteSettingsView: View {
    @StateObject private var viewModel: LoopRemoteSettingsViewModel
    /// What the Files picker fills: a key (.p8) or Loop's QR code from a picture; kept after the picker closes.
    @State private var importTarget: ImportTarget = .key(.loop)
    @State private var isImporterPresented = false
    @State private var photoItem: PhotosPickerItem?
    @State private var qrError: String?
    @State private var importError: String?
    @State private var importedFile: [KeySlot: String] = [:]
    @State private var isClearConfirmationPresented = false
    @State private var isScannerPresented = false
    @State private var expanded: LoopSetupStep?
    @State private var foldedAll = false

    private enum KeySlot: Hashable {
        case loop, glucoMind
    }

    private enum ImportTarget: Equatable {
        case key(KeySlot)
        case qrPicture

        var contentTypes: [UTType] {
            switch self {
            case .key: return [UTType(filenameExtension: "p8") ?? .data, .data]
            case .qrPicture: return [.image]
            }
        }
    }

    init(viewModel: @autoclosure @escaping () -> LoopRemoteSettingsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    private var openStep: LoopSetupStep? { foldedAll ? nil : (expanded ?? viewModel.nextStep) }
    private var patientSuffix: String { viewModel.patientName.map { " pacjenta \($0)" } ?? " tego pacjenta" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                statusCard
                ForEach(viewModel.steps) { step in
                    stepCard(step)
                }
                Label("Kod QR i klucze zostają w pęku kluczy tego telefonu i zapisują się same.", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                if let saveError = viewModel.saveError {
                    Label(saveError, systemImage: "exclamationmark.octagon.fill").font(.footnote).foregroundStyle(.red).padding(.horizontal, 4)
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
        .task { await viewModel.refreshTarget() }
        .refreshable { await viewModel.refreshTarget() }
        .fileImporter(isPresented: $isImporterPresented, allowedContentTypes: importTarget.contentTypes) { result in
            switch result {
            case .success(let url):
                switch importTarget {
                case let .key(slot): importKey(from: url, into: slot)
                case .qrPicture: useQRCode(LoopQRImageReader.read(fileURL: url))
                }
            case .failure:
                if importTarget == .qrPicture { qrError = "Nie udało się otworzyć pliku." } else { importError = "Nie udało się otworzyć pliku." }
            }
        }
        #if os(iOS) && canImport(VisionKit)
        .sheet(isPresented: $isScannerPresented) {
            // The first QR code that is Loop's (otpauth://totp/…) closes the camera.
            QRCodeScanner(accepts: { LoopOTP(url: $0) != nil }) { text in
                viewModel.settings.otpURL = text
                isScannerPresented = false
            }
            .ignoresSafeArea()
        }
        #endif
        .animation(.easeInOut(duration: 0.2), value: openStep)
    }

    // MARK: Status

    @ViewBuilder
    private var statusCard: some View {
        if viewModel.isReady {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark").font(.title3.weight(.bold)).foregroundStyle(.green)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.green.opacity(0.18)))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Gotowe do wysyłania").font(.headline)
                    Text("Polecenia z zakładki Bolus, z rozmowy i z okna WBT idą do Loopa\(viewModel.patientName.map { " pacjenta \($0)" } ?? ""). Posiłek idzie w dwóch krokach: najpierw węglowodany, bolus dopiero gdy Loop je potwierdzi.")
                        .font(.subheadline).foregroundStyle(.secondary)
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
                    Circle().trim(from: 0, to: total > 0 ? CGFloat(done) / CGFloat(total) : 0)
                        .stroke(Color.green, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Text("\(done)/\(total)").font(.subheadline.weight(.bold).monospacedDigit())
                }
                .frame(width: 54, height: 54)
                VStack(alignment: .leading, spacing: 3) {
                    Text(total - done == 1 ? "Jeszcze 1 krok" : "Jeszcze \(total - done) kroki").font(.headline)
                    Text("Potem możesz wysyłać polecenia do Loopa\(viewModel.patientName.map { " pacjenta \($0)" } ?? "").")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(DashboardPalette.cardBackground))
        }
    }

    // MARK: Steps

    private func stepCard(_ step: LoopSetupStep) -> some View {
        let isOpen = openStep == step
        return RemoteSetupStepCard(
            number: (viewModel.steps.firstIndex(of: step) ?? 0) + 1,
            title: title(step),
            summary: summary(step),
            done: viewModel.isDone(step),
            isOpen: isOpen,
            problem: step == .loop && (viewModel.pin == .changed || viewModel.pin == .usedByOtherPatient),
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

    private func title(_ step: LoopSetupStep) -> String {
        switch step {
        case .loop: return "Loop w Nightscout"
        case .secret: return "Kod QR z Loopa"
        case .key: return "Klucz Apple (APNs)"
        case .returnKey: return "Klucz do odpowiedzi Loopa"
        case .limits: return "Limity na tym telefonie"
        }
    }

    private func summary(_ step: LoopSetupStep) -> String? {
        switch step {
        case .loop:
            switch viewModel.pin {
            case .confirmed: return viewModel.target?.apns_environment == "production" ? "TestFlight" : "Xcode"
            case .needsConfirmation: return "Połączony"
            case .changed: return "Nightscout pokazuje innego Loopa: potwierdź go"
            case .usedByOtherPatient: return "Ten Loop jest przypisany do innego pacjenta"
            case .notReady: return viewModel.targetError ?? viewModel.target?.summary ?? "Sprawdzam…"
            }
        case .secret:
            return viewModel.isDone(.secret) ? "Zapisany ••••••" : "Z Loopa na telefonie pacjenta"
        case .key:
            return viewModel.isDone(.key) ? "Key ID \(viewModel.settings.apnsKeyID) · konto \(viewModel.loopTeamID ?? "")" : "Plik .p8 konta, które zbudowało Loopa"
        case .returnKey:
            return viewModel.isDone(.returnKey) ? "Key ID \(viewModel.settings.returnKeyID ?? "")" : "Plik .p8 konta aplikacji Mellis (\(viewModel.identity.teamID))"
        case .limits:
            if !viewModel.isDone(.limits) { return "Sprawdź limity dla tego pacjenta" }
            return "Bolus do \(RemoteCommandFormat.units(viewModel.settings.maxBolusUnits)) j · węgle do \(viewModel.settings.maxCarbsGrams) g"
        }
    }

    @ViewBuilder
    private func content(_ step: LoopSetupStep) -> some View {
        switch step {
        case .loop: loopContent
        case .secret: secretContent
        case .key: keyContent(slot: .loop)
        case .returnKey: keyContent(slot: .glucoMind)
        case .limits: limitsContent
        }
    }

    // MARK: Loop

    @ViewBuilder
    private var loopContent: some View {
        if viewModel.isLoading && viewModel.target == nil {
            ProgressView()
        } else if let error = viewModel.targetError {
            Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
        } else if let target = viewModel.target {
            switch viewModel.pin {
            case .notReady:
                Label(target.summary, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
            case .needsConfirmation, .confirmed:
                Label("Loop\(patientSuffix) jest w Nightscout i przyjmuje polecenia zdalne.", systemImage: "checkmark.circle.fill")
                    .font(.subheadline).foregroundStyle(.green)
                Text("Polecenia z tego profilu pójdą tylko do tego Loopa. Gdy Nightscout pokaże kiedyś innego Loopa, zapytam, zanim cokolwiek wyślę.")
                    .font(.footnote).foregroundStyle(.secondary)
            case .changed:
                Label("Nightscout\(patientSuffix) pokazuje innego Loopa niż przy konfiguracji. Tak się dzieje po nowej instalacji Loopa albo zmianie telefonu, ale też przy pomyłce w Nightscout.", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(.orange)
                Button("To nowy Loop\(patientSuffix)") { viewModel.confirmLoop() }.buttonStyle(.borderedProminent)
            case .usedByOtherPatient:
                Label("Ten sam Loop jest na tym telefonie przypisany do innego pacjenta. Sprawdź, czy Nightscout tego pacjenta jest właściwy: polecenia stąd nie zostaną wysłane.", systemImage: "xmark.octagon.fill")
                    .font(.footnote).foregroundStyle(.red)
            }
            if let max = target.max_bolus_u {
                LabeledContent("Maksymalny bolus w Loopie", value: "\(RemoteCommandFormat.units(max)) j").font(.footnote)
            }
        }
    }

    // MARK: QR code

    @ViewBuilder
    private var secretContent: some View {
        // Loop shows the code on the patient's phone: scanned with this phone's camera, or a screenshot of it read from
        // Photos or Files (sent over AirDrop or a message).
        #if os(iOS) && canImport(VisionKit)
        if DataScannerViewController.isSupported {
            Button {
                qrError = nil
                isScannerPresented = true
            } label: {
                Label("Zeskanuj aparatem", systemImage: "qrcode.viewfinder").fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        #endif
        HStack(spacing: 10) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label("Ze zdjęć", systemImage: "photo").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            Button {
                qrError = nil
                importTarget = .qrPicture
                isImporterPresented = true
            } label: {
                Label("Z pliku", systemImage: "folder").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .controlSize(.large)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                photoItem = nil
                useQRCode(data.map(LoopQRImageReader.read(imageData:)) ?? .failure(.notAnImage))
            }
        }
        if let qrError {
            Label(qrError, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
        }
        HStack {
            SecureField("otpauth://totp/…", text: $viewModel.settings.otpURL)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            #if os(iOS)
            Button("Wklej") {
                if let pasted = UIPasteboard.general.string { viewModel.settings.otpURL = pasted }
            }
            .buttonStyle(.bordered)
            #endif
        }
        if !viewModel.settings.otpURL.isEmpty && viewModel.settings.otp == nil {
            Label("To nie jest kod QR zdalnych poleceń Loopa (adres otpauth://totp z sekretem).", systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
        }
        if viewModel.secretUsedByOtherPatient {
            Label(LoopPatientGuard.secretMessage, systemImage: "xmark.octagon.fill").font(.footnote).foregroundStyle(.red)
        }
        Text("Na telefonie pacjenta w Loopie: Ustawienia → Nightscout → zdalne polecenia (Remote Commands) pokazują kod QR. Zeskanuj go aparatem albo zrób na tamtym telefonie zrzut ekranu i wczytaj go stąd. Z kodu Mellis liczy jednorazowy kod do każdego polecenia.")
            .font(.footnote).foregroundStyle(.secondary)
    }

    // MARK: Keys

    @ViewBuilder
    private func keyContent(slot: KeySlot) -> some View {
        let keyID = slot == .loop ? viewModel.settings.apnsKeyID : (viewModel.settings.returnKeyID ?? "")
        let p8 = slot == .loop ? viewModel.settings.apnsKeyP8 : (viewModel.settings.returnKeyP8 ?? "")
        if p8.isEmpty {
            Button {
                importTarget = .key(slot)
                importError = nil
                isImporterPresented = true
            } label: {
                Label("Wczytaj plik .p8", systemImage: "doc.badge.arrow.up").fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text(importedFile[slot] ?? "Klucz wczytany").font(.subheadline.weight(.semibold))
                    Text(APNsAuthToken.isKeyID(keyID) ? "Key ID \(keyID)" : "Brakuje Key ID").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Button("Zmień") {
                    importTarget = .key(slot)
                    importError = nil
                    isImporterPresented = true
                }
                .font(.subheadline)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.green.opacity(0.1)))
        }
        if !p8.isEmpty && !APNsAuthToken.isKeyID(keyID) {
            TextField("Key ID (10 znaków)", text: slot == .loop
                      ? Binding(get: { viewModel.settings.apnsKeyID }, set: { viewModel.settings.apnsKeyID = $0.uppercased() })
                      : Binding(get: { viewModel.settings.returnKeyID ?? "" }, set: { viewModel.settings.returnKeyID = $0.isEmpty ? nil : $0.uppercased() }))
                .autocorrectionDisabled()
        }
        if slot == .loop && viewModel.needsTeamID {
            TextField("Team ID konta, które zbudowało Loopa", text: Binding(get: { viewModel.settings.teamID ?? "" }, set: { viewModel.settings.teamID = $0.isEmpty ? nil : $0.uppercased() }))
                .autocorrectionDisabled()
            Text("Nightscout nie podaje konta Apple tego Loopa (aplikacja nie ma nazwy com.<TEAM>.loopkit.Loop). Team ID znajdziesz na developer.apple.com → Membership.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        if let importError {
            Label(importError, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
        }
        Text(slot == .loop
             ? "Klucz APNs (Apple Push Notifications service) z developer.apple.com → Keys, z konta, które zbudowało Loopa. Key ID odczytam z nazwy pliku AuthKey_XXXXXXXXXX.p8."
             : "Loop jest zbudowany na innym koncie Apple niż Mellis (\(viewModel.identity.teamID)). Tym kluczem Loop odpowie na polecenie.")
            .font(.footnote).foregroundStyle(.secondary)
    }

    // MARK: Limits

    @ViewBuilder
    private var limitsContent: some View {
        let loopMax = viewModel.target?.max_bolus_u.map { NSDecimalNumber(decimal: $0).doubleValue } ?? 30
        Stepper(value: Binding(
            get: { NSDecimalNumber(decimal: viewModel.settings.maxBolusUnits).doubleValue },
            set: { viewModel.settings.maxBolusUnits = Decimal(($0 * 2).rounded() / 2) }
        ), in: 0.5...max(0.5, loopMax), step: 0.5) {
            LabeledContent("Maksymalny bolus", value: "\(RemoteCommandFormat.units(viewModel.settings.maxBolusUnits)) j")
        }
        Stepper(value: $viewModel.settings.maxCarbsGrams, in: 5...300, step: 5) {
            LabeledContent("Maksymalne węglowodany", value: "\(viewModel.settings.maxCarbsGrams) g")
        }
        if let pumpStep = viewModel.pumpBolusStep {
            LabeledContent("Krok pompy") {
                Label("\(RemoteCommandFormat.units(pumpStep)) j · z Nightscout", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.secondary)
            }
        } else {
            Picker("Krok pompy", selection: $viewModel.settings.bolusIncrement) {
                Text("0,05 j").tag(Decimal(string: "0.05")!)
                Text("0,1 j").tag(Decimal(string: "0.1")!)
            }
        }
        Text("Nie luźniej niż w Loopie: Loop sprawdza swój maksymalny bolus i odrzuci większy.")
            .font(.footnote).foregroundStyle(.secondary)
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
                Label("Potwierdzam: bolus do \(RemoteCommandFormat.units(viewModel.settings.maxBolusUnits)) j, węgle do \(viewModel.settings.maxCarbsGrams) g", systemImage: "checkmark").fontWeight(.semibold).frame(maxWidth: .infinity)
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
                    Label("Usuń ustawienia z tego telefonu", systemImage: "trash").frame(maxWidth: .infinity, alignment: .leading)
                }
                .confirmationDialog("Usunąć ustawienia Loopa z tego telefonu?", isPresented: $isClearConfirmationPresented, titleVisibility: .visible) {
                    Button("Usuń", role: .destructive) {
                        viewModel.clear()
                        importedFile = [:]
                        expanded = nil
                        foldedAll = false
                    }
                    Button("Anuluj", role: .cancel) {}
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(DashboardPalette.cardBackground))
            }
            Text("Wyłączenie zdalnych poleceń w Loopie (albo nowy kod QR) zatrzymuje każde polecenie, także z tego telefonu.")
                .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 4)
        }
    }

    /// A QR code read from a picture fills the field (saved as typed, like a scan or a paste).
    private func useQRCode(_ result: Result<String, LoopQRImageReader.ReadError>) {
        switch result {
        case let .success(url):
            qrError = nil
            viewModel.settings.otpURL = url
        case let .failure(error):
            qrError = error.message
        }
    }

    private func importKey(from url: URL, into slot: KeySlot) {
        switch APNsKeyFile.read(url) {
        case let .failure(error):
            importError = error.message
        case let .success(key):
            importError = nil
            importedFile[slot] = url.lastPathComponent
            switch slot {
            case .loop:
                viewModel.settings.apnsKeyP8 = key.pem
                if let keyID = key.keyID { viewModel.settings.apnsKeyID = keyID }
            case .glucoMind:
                viewModel.settings.returnKeyP8 = key.pem
                if let keyID = key.keyID { viewModel.settings.returnKeyID = keyID }
            }
        }
    }
}
