import SwiftUI
import GlucoMindCore
#if canImport(UIKit)
import UIKit
#endif

// Device mode (self-hosted Mellis, docs-site instalacja/parowanie.md): the first screen of an unpaired phone. No
// account, no e-mail: the phone connects to its family's server with a QR code (or the link from an invitation) and from
// then on signs in with its own keys.

/// "Połącz z serwerem": "Zeskanuj kod", "Wklej link", "Mam kod odzyskiwania".
struct PairingView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var isScannerPresented = false
    @State private var isLinkSheetPresented = false
    @State private var isRecoveryPresented = false
    @State private var isPairing = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                header
                if !container.pairingAcknowledged {
                    // Once per phone, before any pairing (a link that opened the app waits behind it).
                    DIYAcknowledgementCard { container.acceptPairingAcknowledgement() }
                } else if let link = container.incomingPairingLink {
                    PairingConfirmationCard(link: link, isPairing: isPairing, onConfirm: { pair(link) }, onCancel: {
                        container.incomingPairingLink = nil
                    })
                } else {
                    actions
                }
                if let message = errorMessage ?? container.incomingPairingError {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("pairing.error")
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 32)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        #if os(iOS) && canImport(VisionKit)
        .sheet(isPresented: $isScannerPresented) {
            NavigationStack {
                QRCodeScanner(accepts: { PairingLink.parse($0, allowsInsecureHTTP: AppContainer.allowsInsecureServer).isSuccess }) { text in
                    isScannerPresented = false
                    container.receivePairingLink(text: text)
                }
                .ignoresSafeArea()
                .navigationTitle("Zeskanuj kod")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Anuluj") { isScannerPresented = false }
                    }
                }
            }
        }
        #endif
        .sheet(isPresented: $isLinkSheetPresented) {
            PairingLinkEntrySheet { text in
                isLinkSheetPresented = false
                container.receivePairingLink(text: text)
            }
        }
        .sheet(isPresented: $isRecoveryPresented) {
            RecoveryCodeSheet()
        }
        .onChange(of: container.incomingPairingLink) { _, _ in errorMessage = nil }
        #if DEBUG
        // Simulator walkthroughs (MELLIS_AUTO_PAIR=1): the shown link is connected without a tap.
        .task(id: container.incomingPairingLink) {
            guard DeviceModeDebugScene.autoPair, container.pairingAcknowledged, let link = container.incomingPairingLink else { return }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard container.incomingPairingLink == link, !isPairing else { return }
            pair(link)
        }
        #endif
    }

    private var header: some View {
        VStack(spacing: 14) {
            Image("LogoLarge")
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
                .accessibilityHidden(true)
            BrandWordmark.text()
                .font(.largeTitle.weight(.semibold))
                .accessibilityLabel("Mellis")
            Text("Połącz ten telefon z serwerem")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text("Zeskanuj kod QR z ekranu serwera albo z telefonu właściciela. Mellis nie ma kont ani haseł: telefon rozpoznaje się sam kluczem schowanym na tym telefonie.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Button {
                container.incomingPairingError = nil
                #if os(iOS) && canImport(VisionKit)
                if QRCodeScanner.isSupported {
                    isScannerPresented = true
                    return
                }
                #endif
                // No camera scanning here (the simulator, an old phone): the link still works.
                errorMessage = "Ten telefon nie może skanować kodów aparatem. Stuknij Wklej link i wklej link z zaproszenia."
            } label: {
                Label("Zeskanuj kod", systemImage: "qrcode.viewfinder")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.interactive)
            .controlSize(.large)
            Button {
                container.incomingPairingError = nil
                isLinkSheetPresented = true
            } label: {
                Label("Wklej link", systemImage: "link")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.bordered)
            .tint(Brand.interactive)
            .controlSize(.large)
            Button("Mam kod odzyskiwania") {
                container.incomingPairingError = nil
                isRecoveryPresented = true
            }
            .font(.subheadline)
            .tint(Brand.interactive)
            .padding(.top, 6)
            Text("Kod QR dostajesz od właściciela (Ustawienia → Udostępnianie → Zaproś osobę) albo na serwerze: mellis → Połącz telefon właściciela.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
        }
    }

    private func pair(_ link: PairingLink) {
        isPairing = true
        errorMessage = nil
        Task {
            defer { isPairing = false }
            do {
                try await container.pair(with: link)
            } catch let error as DIYAcknowledgementError {
                errorMessage = error.message
            } catch let error as DeviceKeyError {
                errorMessage = error == .cancelled ? "Anulowano." : error.message
            } catch {
                errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się połączyć z serwerem. Sprawdź internet i spróbuj ponownie."
            }
        }
    }
}

/// "Zanim połączysz": the DIY acknowledgement, accepted once on this phone before it can pair (DIYAcknowledgement).
struct DIYAcknowledgementCard: View {
    let onAccept: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Zanim połączysz", systemImage: "exclamationmark.shield")
                .font(.headline)
            Text(DIYAcknowledgement.notice)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("diy.notice")
            Button(action: onAccept) {
                Text(DIYAcknowledgement.acceptTitle)
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.interactive)
            .controlSize(.large)
            .accessibilityIdentifier("diy.accept")
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DashboardPalette.cardBackground))
    }
}

/// The link that came in (camera, paste, deep link), confirmed before anything is sent: the server's address is shown.
private struct PairingConfirmationCard: View {
    let link: PairingLink
    let isPairing: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Połączyć z tym serwerem?", systemImage: "server.rack")
                .font(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("Serwer")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(link.serverURL.absoluteString)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("pairing.server")
            }
            Text(DeviceBiometrics.isAvailable
                 ? "Połącz tylko z serwerem swojej rodziny. Face ID nie jest potrzebny do połączenia: zapyta o niego dopiero zdalny bolus, jeśli właściciel Ci go włączy."
                 : "Połącz tylko z serwerem swojej rodziny. Ten telefon nie ma Face ID ani Touch ID: połączy się i pokaże glukozę, rozmowy i posiłki, ale zdalnego bolusa z niego nie podasz.")
                .accessibilityIdentifier("pairing.biometricsNote")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onConfirm) {
                HStack {
                    Spacer()
                    if isPairing {
                        ProgressView().tint(.white)
                    } else {
                        Text("Połącz").fontWeight(.semibold)
                    }
                    Spacer()
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.interactive)
            .controlSize(.large)
            .disabled(isPairing)
            .accessibilityIdentifier("pairing.connect")
            Button("Anuluj", role: .cancel, action: onCancel)
                .frame(maxWidth: .infinity)
                .disabled(isPairing)
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DashboardPalette.cardBackground))
    }
}

/// "Wklej link": the invitation link pasted (or typed) from a message.
private struct PairingLinkEntrySheet: View {
    let onLink: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("mellis://pair?…", text: $text, axis: .vertical)
                        .lineLimit(2...5)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .accessibilityIdentifier("pairing.link")
                    PasteButton(payloadType: String.self) { strings in
                        if let first = strings.first { text = first }
                    }
                    .labelStyle(.titleAndIcon)
                } header: {
                    Text("Link z zaproszenia")
                } footer: {
                    Text("Wklej cały link albo całą wiadomość z linkiem. Link działa jak klucz: nie przekazuj go dalej.")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Wklej link")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Dalej") {
                        switch PairingLink.parse(text, allowsInsecureHTTP: AppContainer.allowsInsecureServer) {
                        case .success: onLink(text)
                        case let .failure(failure): error = failure.message
                        }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("pairing.link.next")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// "Mam kod odzyskiwania": the only owner lost their phone; the code from the setup note pairs a new one.
private struct RecoveryCodeSheet: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State private var server = ""
    @State private var code = ""
    @State private var isWorking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://mellis.twojadomena.pl", text: $server)
                        .keyboardTypeURL()
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("recovery.server")
                } header: {
                    Text("Adres serwera")
                }
                Section {
                    TextField("XXXXX-XXXXX-XXXXX-XXXXX", text: $code)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                        .accessibilityIdentifier("recovery.code")
                } header: {
                    Text("Kod odzyskiwania")
                } footer: {
                    Text("Kod z notatki z instalacji serwera. Po połączeniu dostaniesz nowy kod, a stary przestanie działać. Nie masz kodu? Na serwerze wpisz mellis i wybierz Odzyskaj dostęp właściciela.")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Button {
                        recover()
                    } label: {
                        HStack {
                            Spacer()
                            if isWorking { ProgressView() } else { Text("Połącz").fontWeight(.semibold) }
                            Spacer()
                        }
                    }
                    .disabled(isWorking || server.trimmingCharacters(in: .whitespaces).isEmpty || !OneTimeCode.isPlausible(code))
                }
            }
            .navigationTitle("Kod odzyskiwania")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
            }
        }
    }

    private func recover() {
        guard case let .success(url) = PairingLink.serverURL(server, allowsInsecureHTTP: AppContainer.allowsInsecureServer) else {
            error = PairingLink.ParseError.insecureServer.message
            return
        }
        isWorking = true
        error = nil
        Task {
            defer { isWorking = false }
            do {
                try await container.recover(server: url, recoveryCode: code)
            } catch let ackError as DIYAcknowledgementError {
                error = ackError.message
            } catch let keyError as DeviceKeyError {
                error = keyError.message
            } catch {
                self.error = DeviceAuthErrorText.message(for: error) ?? "Nie udało się połączyć z serwerem."
            }
        }
    }
}

/// The new recovery code after a recovery, shown once over the patient's screens.
struct NewRecoveryCodeSheet: View {
    let code: String
    let onDone: () -> Void
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    Image(systemName: "key.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(Brand.interactive)
                        .padding(.top, 24)
                    Text("Nowy kod odzyskiwania")
                        .font(.title2.weight(.bold))
                    Text("Stary kod już nie działa. Zapisz nowy w bezpiecznym miejscu (np. w notatce z instalacji). Pokazujemy go tylko teraz.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(code)
                        .font(.title3.monospaced().weight(.semibold))
                        .textSelection(.enabled)
                        .padding(14)
                        .frame(maxWidth: .infinity)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.1)))
                    Button {
                        copyToPasteboard(code)
                        copied = true
                    } label: {
                        Label(copied ? "Skopiowano" : "Kopiuj kod", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .tint(Brand.interactive)
                }
                .padding(.horizontal, 24)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zapisałem", action: onDone)
                }
            }
        }
        .interactiveDismissDisabled()
    }
}

func copyToPasteboard(_ text: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = text
    #endif
}

extension Result {
    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }
}

extension View {
    /// The URL keyboard without capitals (iOS only).
    @ViewBuilder
    func keyboardTypeURL() -> some View {
        #if os(iOS)
        self.keyboardType(.URL).textInputAutocapitalization(.never)
        #else
        self
        #endif
    }
}
