import SwiftUI
import GlucoMindCore

// "Przekaż moje ustawienia Trio/Loop" (docs/device-auth-api.md §8, user docs instalacja/zdalny-bolus.md): an
// owner hands this phone's remote control settings for a patient to a person with a remote bolus grant; the person's
// phone shows "Tomek przekazał Ci ustawienia Trio dla: Zosia" with Zapisz (Face ID) and Odrzuć.

/// The owner's side for one patient: which loop's settings this phone could hand over, sending, and the receipts.
@MainActor
final class HandoffOwnerModel: ObservableObject {
    @Published private(set) var receipts: [RemoteSettingsHandoff] = []
    @Published private(set) var isSending = false
    @Published var errorMessage: String?
    @Published private(set) var notice: String?

    let patientID: String
    let patientName: String
    private let sender: RemoteSettingsHandoffSender?
    private let api: RemoteSettingsHandoffAPI?
    /// The loop the patient's remote commands go to, when known (Trio unless the server says Loop).
    private let sendsToLoop: () -> Bool?

    init(patientID: String, patientName: String, sender: RemoteSettingsHandoffSender?, api: RemoteSettingsHandoffAPI?, sendsToLoop: @escaping () -> Bool?) {
        self.patientID = patientID
        self.patientName = patientName
        self.sender = sender
        self.api = api
        self.sendsToLoop = sendsToLoop
    }

    var isAvailable: Bool { sender != nil }

    /// The loop whose complete settings this phone has for the patient; nil: nothing to hand over yet.
    var loopKind: HandoffLoopKind? {
        guard let sender else { return nil }
        let preferred: [HandoffLoopKind] = sendsToLoop() == true ? [.loop, .trio] : [.trio, .loop]
        return preferred.first { sender.handableSettings(patientID: patientID, loopKind: $0) != nil }
    }

    /// The loop named on the button before anything is set up here.
    var expectedLoopName: String { sendsToLoop() == true ? "Loop" : "Trio" }

    func receipts(for person: PatientPerson) -> [RemoteSettingsHandoff] {
        receipts.filter { $0.to_user_id == person.user_id }
    }

    func loadReceipts() async {
        guard let api else { return }
        if let rows = try? await api.listPatientHandoffs(patientID: patientID) { receipts = rows }
    }

    /// Face ID, then one sealed copy per phone of the person.
    @discardableResult
    func send(to person: PatientPerson, from you: PatientPerson?) async -> Bool {
        guard let sender, let loopKind else {
            errorMessage = RemoteSettingsHandoffError.nothingToHandOver.message
            return false
        }
        isSending = true
        defer { isSending = false }
        do {
            let count = try await sender.send(
                patientID: patientID, patientName: patientName,
                fromUserID: you?.user_id ?? "", fromName: you?.display_name ?? "",
                toUserID: person.user_id, toName: person.display_name, loopKind: loopKind
            )
            notice = HandoffText.sent(loopKind: loopKind, person: person.display_name, phones: count)
            errorMessage = nil
            await loadReceipts()
            return true
        } catch RemoteSettingsHandoffError.cancelled {
            return false
        } catch let error as RemoteSettingsHandoffError {
            errorMessage = error.message
            return false
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? HandoffText.errorText(error) ?? "Nie udało się przekazać ustawień."
            return false
        }
    }

    func revoke(_ receipt: RemoteSettingsHandoff) async {
        guard let api else { return }
        do {
            try await api.revokeHandoff(patientID: patientID, handoffID: receipt.handoff_id)
            await loadReceipts()
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się cofnąć przekazania."
        }
    }
}

enum HandoffText {
    static func sent(loopKind: HandoffLoopKind, person: String, phones: Int) -> String {
        let target = phones == 1 ? "na telefon tej osoby" : "na \(phones) telefony tej osoby"
        return "Przekazano ustawienia \(loopKind.displayName) \(target). \(person) zapisze je u siebie jednym dotknięciem; czekają 7 dni."
    }

    static func receipt(_ receipt: RemoteSettingsHandoff) -> String {
        if let consumed = receipt.consumed_at.flatMap(ServerDate.parse) {
            return "\(receipt.to_device_name): odebrane \(RemoteCommandFormat.dayAndTime(consumed))"
        }
        let sent = ServerDate.parse(receipt.created_at).map(RemoteCommandFormat.dayAndTime) ?? ""
        return "\(receipt.to_device_name): czeka (wysłane \(sent))"
    }

    static func errorText(_ error: Error) -> String? {
        guard let apiError = error as? APIClientError else { return nil }
        switch apiError.problemCode {
        case "HANDOFF_KEY_CHANGED": return "Telefon tej osoby zmienił klucz (potwierdziła zdalny bolus). Przekaż ustawienia jeszcze raz."
        case "REMOTE_BOLUS_NOT_GRANTED": return "Ta osoba nie ma włączonego zdalnego bolusa."
        case "HANDOFF_SIGNATURE_INVALID": return "Serwer nie przyjął podpisu tego telefonu. Nic nie zostało przekazane."
        default: return nil
        }
    }
}

/// PersonDetailView (owners): "Przekaż moje ustawienia Trio" for a person with a remote bolus grant.
struct HandOverSettingsSection: View {
    @ObservedObject var handoff: HandoffOwnerModel
    @ObservedObject var sharing: DeviceSharingViewModel
    let person: PatientPerson

    var body: some View {
        Section {
            if let notice = handoff.notice {
                Label(notice, systemImage: "checkmark.seal.fill")
                    .font(.footnote)
                    .foregroundStyle(Brand.interactive)
            }
            if let error = handoff.errorMessage {
                SettingsErrorRow(message: error)
            }
            if let kind = handoff.loopKind {
                Button {
                    Task { await handoff.send(to: person, from: sharing.people?.you) }
                } label: {
                    SettingsRowLabel(title: "Przekaż moje ustawienia \(kind.displayName)", subtitle: "Sekret, klucze APNs i limity z tego telefonu", systemImage: "key.horizontal.fill", tint: SettingsColor.remoteBolus)
                }
                .disabled(handoff.isSending)
                .accessibilityIdentifier("person.handOverSettings")
            } else {
                SettingsRowLabel(title: "Przekaż moje ustawienia \(handoff.expectedLoopName)", subtitle: "Najpierw ustaw zdalne sterowanie na tym telefonie", systemImage: "key.horizontal.fill", tint: SettingsColor.unavailable)
            }
            ForEach(handoff.receipts(for: person)) { receipt in
                HStack {
                    Text(HandoffText.receipt(receipt))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if receipt.consumed_at == nil {
                        Button("Cofnij", role: .destructive) { Task { await handoff.revoke(receipt) } }
                            .buttonStyle(.borderless)
                            .font(.footnote)
                    }
                }
            }
        } header: {
            Text("Ustawienia pętli")
        } footer: {
            Text("\(person.display_name) nie musi niczego przepisywać: ustawienia zdalnego sterowania z tego telefonu (sekret pętli, klucze APNs i limity) trafią zaszyfrowane tylko na telefony tej osoby. Serwer ich nie odczyta. Limity można potem tylko zaostrzyć.")
        }
        .task { await handoff.loadReceipts() }
    }
}

// MARK: - Recipient

/// The packages waiting for this phone, for one patient (the patient page, Zdalny bolus) or all (the sheet).
struct HandoffInboxRows: View {
    @ObservedObject var inbox: RemoteSettingsInboxModel
    let handoffs: [RemoteSettingsHandoff]
    var onSaved: ((RemoteSettingsHandoff) -> Void)? = nil

    var body: some View {
        if let error = inbox.errorMessage {
            SettingsErrorRow(message: error)
        }
        ForEach(handoffs) { handoff in
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 14) {
                    SettingsIcon("key.horizontal.fill", tint: SettingsColor.remoteBolus)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(handoff.title)
                            .font(.body.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Sekret \(handoff.loop_kind.displayName), klucze APNs i limity z telefonu: \(handoff.from_name). Zapiszą się na tym telefonie tak, jak wpisane ręcznie.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                HStack(spacing: 12) {
                    Button {
                        Task {
                            if await inbox.save(handoff) { onSaved?(handoff) }
                        }
                    } label: {
                        Label("Zapisz", systemImage: handoff.recipient_key == .bolus ? "faceid" : "square.and.arrow.down")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.interactive)
                    .accessibilityIdentifier("handoff.save")
                    Button(role: .destructive) {
                        Task { await inbox.reject(handoff) }
                    } label: {
                        Text("Odrzuć").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("handoff.reject")
                }
                .disabled(inbox.isWorking)
            }
            .padding(.vertical, 4)
        }
    }
}

/// A section for one patient's waiting packages (nothing when there are none) and the notice after a save.
struct HandoffInboxSection: View {
    @ObservedObject var inbox: RemoteSettingsInboxModel
    let patientID: String

    var body: some View {
        let waiting = inbox.pending(for: patientID)
        if !waiting.isEmpty || inbox.savedNotice != nil {
            Section {
                if let notice = inbox.savedNotice {
                    Label(notice + " Zdalne sterowanie jest gotowe do wysyłania.", systemImage: "checkmark.seal.fill")
                        .font(.footnote)
                        .foregroundStyle(Brand.interactive)
                        .onTapGesture { inbox.dismissNotice() }
                }
                HandoffInboxRows(inbox: inbox, handoffs: waiting)
            } header: {
                Text("Przekazane ustawienia")
            }
        }
    }
}

/// Shown over the app when a package is waiting (app start, return to the app, after confirming remote bolus).
struct HandoffInboxSheet: View {
    @ObservedObject var inbox: RemoteSettingsInboxModel
    let onShowSettings: (String) -> Void
    let onClose: () -> Void
    @State private var saved: RemoteSettingsHandoff?

    var body: some View {
        NavigationStack {
            List {
                if let saved {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Gotowe do wysyłania", systemImage: "checkmark.circle.fill")
                                .font(.headline)
                                .foregroundStyle(.green)
                            Text("Zapisano ustawienia \(saved.loop_kind.displayName) dla: \(saved.patient_name) na tym telefonie. Limity od: \(saved.from_name); możesz je zaostrzyć w ustawieniach.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        Button {
                            onShowSettings(saved.patient_id)
                        } label: {
                            SettingsRowLabel(title: "Zdalne sterowanie \(saved.loop_kind.displayName)", subtitle: "Zobacz ustawienia i limity", systemImage: "antenna.radiowaves.left.and.right", tint: SettingsColor.remoteBolus)
                        }
                    }
                }
                if !inbox.pending.isEmpty {
                    Section {
                        HandoffInboxRows(inbox: inbox, handoffs: inbox.pending) { saved = $0 }
                    } footer: {
                        Text("Ustawienia przyszły zaszyfrowane tylko dla tego telefonu; serwer ich nie odczyta. Odrzucone znikną z serwera.")
                    }
                }
            }
            .navigationTitle("Ustawienia pętli")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(saved != nil || inbox.pending.isEmpty ? "Gotowe" : "Później", action: onClose)
                }
            }
        }
    }
}
