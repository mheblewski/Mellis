import SwiftUI
import GlucoMindCore

// Device mode (self-hosted Mellis): Ustawienia → pacjent → "Osoby i udostępnianie" (people, permissions, their phones,
// invitations by QR code), Ustawienia → "Ten telefon" (own phones, "Połącz kolejny telefon", "Odłącz"), "Dołącz" (an
// invitation on a paired phone) and "Dodaj pacjenta". Codes and QR replace e-mails.

/// Ustawienia → pacjent → Osoby i udostępnianie: the people of one patient and the open invitations.
struct DeviceSharingView: View {
    @StateObject var viewModel: DeviceSharingViewModel
    /// "Przekaż moje ustawienia Trio/Loop" (owners, device mode); unavailable by default.
    @StateObject var handoff = HandoffOwnerModel(patientID: "", patientName: "", sender: nil, api: nil, sendsToLoop: { nil })
    /// The person left the patient: the app reads the patient list again.
    let onLeft: () -> Void

    @State private var isInvitePresented = false
    @State private var invitationToRevoke: OpenInvitation?

    var body: some View {
        List {
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let notice = viewModel.notice {
                Section {
                    Label(notice, systemImage: "checkmark.seal.fill")
                        .font(.footnote)
                        .foregroundStyle(Brand.interactive)
                        .onTapGesture { viewModel.dismissNotice() }
                }
            }
            if let people = viewModel.people {
                if let you = people.you, you.remote_bolus.state == .awaitingConfirmation {
                    RemoteBolusConfirmSection(viewModel: viewModel)
                }
                peopleSection(people)
                if !people.invitations.isEmpty {
                    invitationsSection(people)
                }
                if people.you_are_owner {
                    inviteSection(people)
                }
            }
        }
        .settingsListStyle()
        .overlay {
            if viewModel.isLoading { BrandSpinner() }
        }
        .navigationTitle("Osoby i udostępnianie")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .refreshable { await viewModel.load() }
        .task { await viewModel.load() }
        .sheet(isPresented: $isInvitePresented, onDismiss: { Task { await viewModel.load() } }) {
            InvitePersonView(viewModel: InvitePersonViewModel(api: viewModel.api, patientID: viewModel.patientID, patientName: viewModel.patientName))
        }
        .confirmationDialog(
            "Cofnąć zaproszenie?",
            isPresented: Binding(get: { invitationToRevoke != nil }, set: { if !$0 { invitationToRevoke = nil } }),
            titleVisibility: .visible,
            presenting: invitationToRevoke
        ) { invitation in
            Button("Cofnij zaproszenie", role: .destructive) {
                Task { await viewModel.revoke(invitation) }
            }
            Button("Anuluj", role: .cancel) {}
        } message: { invitation in
            Text("Kod zaproszenia dla: \(invitation.title) przestanie działać.")
        }
    }

    private func peopleSection(_ people: PatientPeopleResponse) -> some View {
        Section {
            ForEach(people.sortedPeople) { person in
                NavigationLink {
                    PersonDetailView(viewModel: viewModel, person: person, onLeft: onLeft, handoff: handoff)
                } label: {
                    PersonRow(person: person, showsDevices: people.you_are_owner)
                }
            }
        } header: {
            Text("Osoby")
        }
    }

    private func invitationsSection(_ people: PatientPeopleResponse) -> some View {
        Section("Zaproszenia") {
            ForEach(people.invitations) { invitation in
                OpenInvitationRow(invitation: invitation)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if people.you_are_owner {
                            Button("Cofnij", role: .destructive) { invitationToRevoke = invitation }
                        }
                    }
                    .contextMenu {
                        if people.you_are_owner {
                            Button("Cofnij zaproszenie", role: .destructive) { invitationToRevoke = invitation }
                        }
                    }
            }
        }
    }

    private func inviteSection(_ people: PatientPeopleResponse) -> some View {
        Section {
            Button {
                isInvitePresented = true
            } label: {
                SettingsRowLabel(title: "Zaproś osobę", systemImage: "person.badge.plus", tint: SettingsColor.people)
            }
            .disabled(people.isFull)
            .accessibilityIdentifier("sharing.invite")
        } footer: {
            if people.isFull {
                Text("Osiągnięto limit \(PatientPeopleResponse.maxPeople) osób (razem z zaproszeniami). Usuń kogoś albo cofnij zaproszenie.")
            } else {
                Text("\(people.peopleCount) z \(PatientPeopleResponse.maxPeople) miejsc zajętych (razem z zaproszeniami). Zaproszenie działa 7 dni i tylko raz.")
            }
        }
    }
}

private struct PersonRow: View {
    let person: PatientPerson
    let showsDevices: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(person.display_name)
                    .foregroundStyle(.primary)
                if person.isYou {
                    SharingBadge(text: "Ty", prominent: false)
                }
                if person.is_owner {
                    SharingBadge(text: "Właściciel", prominent: true)
                }
            }
            Text(person.permissions.summary(remoteBolus: person.remote_bolus.state))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if showsDevices, let devices = person.devices {
                Text(DeviceText.count(devices.count))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct OpenInvitationRow: View {
    let invitation: OpenInvitation

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(invitation.title)
                SharingBadge(text: "Czeka na przyjęcie", prominent: false, tint: .amber)
            }
            Text(invitation.permissions.summary())
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let expires = ServerDate.parse(invitation.expires_at) {
                Text("Ważne do \(RemoteCommandFormat.dayAndTime(expires))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct SharingBadge: View {
    let text: String
    let prominent: Bool
    /// A family of the brand palette (an amber "Czeka na …"); nil: teal when prominent, else grey.
    var tint: BrandTint? = nil

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(tint?.glyph ?? (prominent ? BrandTint.teal.glyph : Color.secondary))
            .background(
                Capsule().fill(tint?.background ?? (prominent ? BrandTint.teal.background : Color.secondary.opacity(0.14)))
            )
            .lineLimit(1)
            .fixedSize()
    }
}

/// An owner granted this person remote bolus; it counts once confirmed with Face ID on this phone.
private struct RemoteBolusConfirmSection: View {
    @ObservedObject var viewModel: DeviceSharingViewModel

    var body: some View {
        Section {
            RemoteBolusConfirmButton(viewModel: viewModel)
        } header: {
            Text("Zdalny bolus")
        } footer: {
            Text(DeviceBiometrics.isAvailable
                 ? "Właściciel włączył Ci zdalny bolus. Potwierdź go Face ID na tym telefonie: telefon utworzy wtedy swój klucz do bolusa i dopiero potem polecenia zadziałają.\n\n\(DIYAcknowledgement.confirmingAccepts)"
                 : DeviceBiometrics.unavailableMessage)
        }
    }
}

private struct RemoteBolusConfirmButton: View {
    @ObservedObject var viewModel: DeviceSharingViewModel

    var body: some View {
        if DeviceBiometrics.isAvailable {
            Button {
                Task { await viewModel.confirmRemoteBolus() }
            } label: {
                SettingsRowLabel(title: "Chcę podawać bolus zdalnie dla: \(viewModel.patientName)", systemImage: "faceid", tint: SettingsColor.remoteBolus)
            }
            .disabled(viewModel.isSaving)
            .accessibilityIdentifier("sharing.confirmRemoteBolus")
        } else {
            // No Face ID / Touch ID: no bolus key can exist on this phone.
            SettingsRowLabel(title: "Zdalny bolus niedostępny na tym telefonie", subtitle: "Brak Face ID i Touch ID", systemImage: "faceid", tint: SettingsColor.unavailable)
        }
    }
}

/// A person: permissions (owners edit them, also their own remote bolus), their phones with "Odłącz", remove / leave.
struct PersonDetailView: View {
    @ObservedObject var viewModel: DeviceSharingViewModel
    let person: PatientPerson
    let onLeft: () -> Void
    var handoff: HandoffOwnerModel?

    @Environment(\.dismiss) private var dismiss
    @State private var permissions: SharingPermissions
    @State private var isRemoveConfirmationPresented = false
    @State private var deviceToRevoke: PairedDevice?
    /// Remote bolus was just granted and this phone has settings to hand over: offered at once.
    @State private var isHandOverOffered = false

    init(viewModel: DeviceSharingViewModel, person: PatientPerson, onLeft: @escaping () -> Void, handoff: HandoffOwnerModel? = nil) {
        self.viewModel = viewModel
        self.person = person
        self.onLeft = onLeft
        self.handoff = handoff
        _permissions = State(initialValue: person.editablePermissions)
    }

    /// An owner looking at someone else who has remote bolus granted (confirmed or waiting).
    private var showsHandOver: Bool {
        canEdit && !current.isYou && current.remote_bolus.state != .off && !hasChanges && handoff?.isAvailable == true
    }

    private var current: PatientPerson {
        viewModel.people?.people.first { $0.user_id == person.user_id } ?? person
    }

    private var canEdit: Bool { viewModel.isOwner }
    private var hasChanges: Bool { permissions.normalized != current.editablePermissions }

    var body: some View {
        Form {
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                HStack(spacing: 6) {
                    Text(current.display_name)
                        .font(.headline)
                    if current.isYou { SharingBadge(text: "Ty", prominent: false) }
                    if current.is_owner { SharingBadge(text: "Właściciel", prominent: true) }
                }
            }
            PermissionSwitches(permissions: $permissions, remoteBolusDetail: remoteBolusDetail)
                .disabled(!canEdit || viewModel.isSaving)
            if !canEdit {
                Section {
                    EmptyView()
                } footer: {
                    Text("Uprawnienia zmienia właściciel.")
                }
            }
            if current.isYou && current.remote_bolus.state == .awaitingConfirmation && !hasChanges {
                Section {
                    RemoteBolusConfirmButton(viewModel: viewModel)
                } footer: {
                    Text(DeviceBiometrics.isAvailable ? "Potwierdź Face ID na tym telefonie: dopiero wtedy zdalny bolus zadziała." : DeviceBiometrics.unavailableMessage)
                }
            }
            if showsHandOver, let handoff {
                HandOverSettingsSection(handoff: handoff, sharing: viewModel, person: current)
            }
            if canEdit, let devices = current.devices {
                devicesSection(devices)
            }
            if current.isYou || canEdit {
                Section {
                    Button(current.isYou ? "Opuść udostępnianie" : "Usuń z udostępniania", role: .destructive) {
                        isRemoveConfirmationPresented = true
                    }
                    .disabled(viewModel.isSaving)
                } footer: {
                    if current.isYou {
                        Text("Przestaniesz widzieć dane pacjenta: \(viewModel.patientName). Wrócić można tylko z nowym zaproszeniem.")
                    }
                }
            }
        }
        .navigationTitle(current.display_name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if canEdit && hasChanges {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zapisz") {
                        Task {
                            let grants = permissions.normalized.remote_commands && !current.editablePermissions.remote_commands
                            if await viewModel.update(current, to: permissions) {
                                permissions = current.editablePermissions
                                if grants, !current.isYou, handoff?.loopKind != nil { isHandOverOffered = true }
                            }
                        }
                    }
                    .disabled(viewModel.isSaving || permissions.normalized.isEmpty)
                    .accessibilityIdentifier("person.save")
                }
            }
        }
        .onChange(of: current) { _, updated in
            if !hasChanges { permissions = updated.editablePermissions }
        }
        .confirmationDialog(
            current.isYou ? "Opuścić udostępnianie?" : "Usunąć tę osobę z udostępniania?",
            isPresented: $isRemoveConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button(current.isYou ? "Opuść" : "Usuń", role: .destructive) {
                Task {
                    let removed = current
                    if await viewModel.remove(removed) {
                        if removed.isYou { onLeft() } else { dismiss() }
                    }
                }
            }
            Button("Anuluj", role: .cancel) {}
        } message: {
            Text(current.isYou ? "Dane i powiadomienia tego pacjenta znikną z tego telefonu." : "Osoba: \(current.display_name). Straci dostęp i przestanie dostawać powiadomienia. Jej telefony pozostaną połączone z serwerem: odłącz je, jeśli zaginęły.")
        }
        .confirmationDialog(
            "Przekazać też Twoje ustawienia \(handoff?.loopKind?.displayName ?? "pętli")?",
            isPresented: $isHandOverOffered,
            titleVisibility: .visible
        ) {
            Button("Przekaż ustawienia") {
                Task { await handoff?.send(to: current, from: viewModel.people?.you) }
            }
            .accessibilityIdentifier("person.handOverOffer")
            Button("Nie teraz", role: .cancel) {}
        } message: {
            Text("\(current.display_name) nie będzie musieć przepisywać sekretu, kluczy APNs ani limitów. Trafią zaszyfrowane tylko na telefony tej osoby.")
        }
        .confirmationDialog(
            "Odłączyć ten telefon?",
            isPresented: Binding(get: { deviceToRevoke != nil }, set: { if !$0 { deviceToRevoke = nil } }),
            titleVisibility: .visible,
            presenting: deviceToRevoke
        ) { device in
            Button("Odłącz", role: .destructive) {
                Task { await viewModel.revoke(device: device, of: current) }
            }
            Button("Anuluj", role: .cancel) {}
        } message: { device in
            Text("\(device.name) traci dostęp od razu. Żeby go znów używać, trzeba go połączyć nowym kodem.")
        }
    }

    private func devicesSection(_ devices: [PairedDevice]) -> some View {
        Section {
            if devices.isEmpty {
                Text("Brak połączonych telefonów.")
                    .foregroundStyle(.secondary)
            }
            ForEach(devices) { device in
                HStack {
                    DeviceRow(device: device)
                    Spacer()
                    if !device.this_device {
                        Button("Odłącz", role: .destructive) { deviceToRevoke = device }
                            .buttonStyle(.borderless)
                    }
                }
            }
        } header: {
            Text("Telefony")
        } footer: {
            Text("Zgubiony telefon odłącz od razu: traci dostęp do danych i nie poda bolusa.")
        }
    }

    private var remoteBolusDetail: String {
        switch current.remote_bolus.state {
        case .awaitingConfirmation where permissions.remote_commands:
            return current.isYou ? "Czeka na Twoje potwierdzenie Face ID na tym telefonie." : "Czeka na potwierdzenie Face ID na telefonie tej osoby."
        case .on where permissions.remote_commands:
            return "Włączony i potwierdzony."
        default:
            return current.isYou ? "Potwierdzisz go Face ID na tym telefonie." : "Osoba potwierdzi go Face ID na swoim telefonie."
        }
    }
}

/// The four switches of a person or an invitation. "Zarządza udostępnianiem" = co-owner: glucose and AI stay on with it;
/// "Zdalny bolus" needs AI chats.
struct PermissionSwitches: View {
    @Binding var permissions: SharingPermissions
    let remoteBolusDetail: String

    var body: some View {
        Section {
            PermissionToggle(title: "Glukoza i alarmy", detail: "Dashboard, wykres, ostrzeżenia o glukozie.", isOn: lockedBinding(\.glucose_alerts))
                .disabled(permissions.locksOtherSwitches)
            PermissionToggle(title: "Rozmowy z AI i posiłki", detail: "Czat, posiłki, przypomnienia i pozostałe powiadomienia.", isOn: lockedBinding(\.ai_chat_meals))
                .disabled(permissions.locksOtherSwitches)
            PermissionToggle(title: "Zarządza udostępnianiem", detail: "Współwłaściciel: zaprasza, zmienia uprawnienia, odłącza telefony, włącza zdalny bolus.", isOn: Binding(
                get: { permissions.manage_sharing },
                set: { on in
                    permissions.manage_sharing = on
                    permissions = permissions.normalized
                }
            ))
            if permissions.allowsRemoteBolus {
                PermissionToggle(title: "Zdalny bolus", detail: remoteBolusDetail, isOn: $permissions.remote_commands)
                    .accessibilityIdentifier("permission.remoteBolus")
            }
        } header: {
            Text("Uprawnienia")
        } footer: {
            if permissions.locksOtherSwitches {
                Text(SharingPermissions.coOwnerNote)
            } else if permissions.isEmpty {
                Text("Włącz co najmniej glukozę albo rozmowy z AI.")
            } else if !permissions.allowsRemoteBolus {
                Text("Zdalny bolus wymaga rozmów z AI i posiłków.")
            } else {
                Text("Zdalny bolus wysyła bolus i węglowodany do Trio albo Loopa. Każde polecenie potwierdza się Face ID.")
            }
        }
    }

    private func lockedBinding(_ key: WritableKeyPath<SharingPermissions, Bool>) -> Binding<Bool> {
        Binding(
            get: { permissions.locksOtherSwitches || permissions[keyPath: key] },
            set: { on in
                guard !permissions.locksOtherSwitches else { return }
                permissions[keyPath: key] = on
                permissions = permissions.normalized
            }
        )
    }
}

struct PermissionToggle: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .tint(Brand.interactive)
    }
}

/// "Zaproś osobę": first name and permissions, then the QR code of the invitation and the link to send.
struct InvitePersonView: View {
    @StateObject var viewModel: InvitePersonViewModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let created = viewModel.created, let message = viewModel.shareMessage {
                    PairingCodeContent(
                        title: "Zaproszenie gotowe",
                        note: "\(viewModel.trimmedName) w swojej aplikacji Mellis stuka Zeskanuj kod i skanuje ten kod. Jeśli jesteście daleko, wyślij link: działa jak klucz, tylko dla tej osoby. Zaproszenie działa 7 dni i tylko raz; możesz je cofnąć w Udostępnianiu.",
                        code: created.pairing,
                        shareMessage: message
                    )
                } else {
                    form
                }
            }
            .navigationTitle(viewModel.created == nil ? "Zaproś osobę" : "")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                if viewModel.created == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Anuluj") { dismiss() }
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Gotowe") { dismiss() }
                    }
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section {
                TextField("Imię", text: $viewModel.firstName)
                    #if os(iOS)
                    .textContentType(.givenName)
                    #endif
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .accessibilityIdentifier("invite.name")
            } header: {
                Text("Osoba")
            } footer: {
                Text("Tak będzie widoczna w Udostępnianiu, w powiadomieniach i dla AI. Bez e-maila i hasła.")
            }
            PermissionSwitches(permissions: $viewModel.permissions, remoteBolusDetail: "Osoba potwierdzi go Face ID na swoim telefonie.")
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                Button {
                    nameFocused = false
                    Task { await viewModel.send() }
                } label: {
                    HStack {
                        Spacer()
                        if viewModel.isSending {
                            ProgressView().tint(.white)
                        } else {
                            Text("Utwórz zaproszenie").fontWeight(.semibold)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                }
                .foregroundStyle(.white)
                .listRowBackground(viewModel.canSend ? Brand.interactive : Brand.interactive.opacity(0.4))
                .disabled(!viewModel.canSend)
                .accessibilityIdentifier("invite.create")
            }
        }
    }
}

/// A one-time code as a QR code, with "Udostępnij link" (share sheet) and "Kopiuj link" (invitation, another phone).
struct PairingCodeContent: View {
    let title: String
    let note: String
    let code: PairingCode
    let shareMessage: String
    @State private var copied = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Text(title)
                    .font(.title2.weight(.bold))
                    .padding(.top, 12)
                if let image = QRCodeImage.make(code.pairing_url) {
                    Image(decorative: image, scale: 1)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 260)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white))
                        .accessibilityLabel("Kod QR")
                        .accessibilityIdentifier("pairing.qr")
                }
                if let expires = ServerDate.parse(code.expires_at) {
                    Text("Ważny do \(RemoteCommandFormat.dayAndTime(expires))")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                ShareLink(item: shareMessage) {
                    Label("Udostępnij link", systemImage: "square.and.arrow.up")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(Brand.interactive)
                .controlSize(.large)
                Button {
                    copyToPasteboard(code.pairing_url)
                    copied = true
                } label: {
                    Label(copied ? "Skopiowano" : "Kopiuj link", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .tint(Brand.interactive)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }
}

/// Ustawienia → Ten telefon: this phone and the server, "Połącz kolejny telefon", the person's other phones, the bolus
/// key, "Połącz ponownie" and "Odłącz ten telefon".
struct ThisPhoneView: View {
    @StateObject var viewModel: ThisPhoneViewModel
    @EnvironmentObject private var container: AppContainer
    @State private var isCodePresented = false
    @State private var isUnpairConfirmationPresented = false
    @State private var deviceToRevoke: PairedDevice?
    @State private var isRepairing = false
    @State private var repairMessage: String?

    var body: some View {
        List {
            if let error = viewModel.errorMessage {
                Section { SettingsErrorRow(message: error) }
            }
            Section {
                SettingsValueRow(title: "Telefon", value: viewModel.thisDevice?.name ?? AppContainer.deviceName, systemImage: "iphone", tint: SettingsColor.phone)
                if let name = container.pairing?.displayName {
                    SettingsValueRow(title: "Osoba", value: name, systemImage: "person.fill", tint: SettingsColor.phone)
                }
                if let server = container.pairing?.serverURL {
                    SettingsValueRow(title: "Serwer", value: server.host ?? server.absoluteString, systemImage: "server.rack", tint: SettingsColor.phone)
                }
                if let pairedAt = container.pairing?.pairedAt {
                    SettingsValueRow(title: "Połączony", value: RemoteCommandFormat.dayAndTime(pairedAt), systemImage: "link", tint: SettingsColor.phone)
                }
                SettingsValueRow(title: "Klucz do zdalnego bolusa", value: bolusKeyText, systemImage: "key.fill", tint: hasBolusKey ? SettingsColor.remoteBolus : SettingsColor.unavailable)
            } header: {
                Text("Ten telefon")
            } footer: {
                Text(bolusKeyFooter)
            }
            Section {
                Button {
                    Task {
                        await viewModel.createPairingCode()
                        if viewModel.pairingCode != nil { isCodePresented = true }
                    }
                } label: {
                    SettingsRowLabel(title: "Połącz kolejny telefon", systemImage: "qrcode", tint: SettingsColor.phone)
                }
                .disabled(viewModel.isSaving)
                .accessibilityIdentifier("thisPhone.pairAnother")
            } footer: {
                Text("Nowy telefon skanuje kod w ekranie łączenia (działa 10 minut) i ma te same uprawnienia co ten. Potem odłącz stary telefon.")
            }
            if !viewModel.otherDevices.isEmpty {
                Section("Inne Twoje telefony") {
                    ForEach(viewModel.otherDevices) { device in
                        HStack {
                            DeviceRow(device: device)
                            Spacer()
                            Button("Odłącz", role: .destructive) { deviceToRevoke = device }
                                .buttonStyle(.borderless)
                        }
                    }
                }
            }
            Section {
                Button {
                    repair()
                } label: {
                    if isRepairing {
                        ProgressView()
                    } else {
                        SettingsRowLabel(title: "Połącz ponownie", systemImage: "arrow.triangle.2.circlepath", tint: SettingsColor.phone)
                    }
                }
                .disabled(isRepairing)
                if let repairMessage {
                    Text(repairMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("Nowy klucz tego telefonu i nowe połączenie z serwerem, gdy coś przestało działać. Po zmianie Face ID wystarczy ustawić zdalny bolus ponownie na stronie pacjenta.")
            }
            Section {
                Button("Odłącz ten telefon", role: .destructive) {
                    isUnpairConfirmationPresented = true
                }
                .accessibilityIdentifier("thisPhone.unpair")
            } footer: {
                Text("Przed oddaniem telefonu komuś innemu. Telefon wróci do ekranu łączenia z serwerem.")
            }
        }
        .settingsListStyle()
        .navigationTitle("Ten telefon")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .overlay {
            if viewModel.isLoading { BrandSpinner() }
        }
        .refreshable { await viewModel.load() }
        .task { await viewModel.load() }
        .sheet(isPresented: $isCodePresented, onDismiss: {
            viewModel.clearPairingCode()
            Task { await viewModel.load() }
        }) {
            if let code = viewModel.pairingCode {
                NavigationStack {
                    PairingCodeContent(
                        title: "Połącz kolejny telefon",
                        note: "Na nowym telefonie otwórz Mellis i stuknij Zeskanuj kod. Kod działa 10 minut i tylko raz. Nowy telefon będzie Twój, z tymi samymi uprawnieniami.",
                        code: code,
                        shareMessage: code.pairing_url
                    )
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Gotowe") { isCodePresented = false }
                        }
                    }
                }
            }
        }
        .confirmationDialog("Odłączyć ten telefon?", isPresented: $isUnpairConfirmationPresented, titleVisibility: .visible) {
            Button("Odłącz", role: .destructive) {
                Task { await container.unpairThisPhone() }
            }
            Button("Anuluj", role: .cancel) {}
        } message: {
            Text("Ten telefon straci dostęp do danych pacjentów. Żeby znów go używać, trzeba go połączyć nowym kodem.")
        }
        .confirmationDialog(
            "Odłączyć ten telefon?",
            isPresented: Binding(get: { deviceToRevoke != nil }, set: { if !$0 { deviceToRevoke = nil } }),
            titleVisibility: .visible,
            presenting: deviceToRevoke
        ) { device in
            Button("Odłącz", role: .destructive) {
                Task { await viewModel.revoke(device) }
            }
            Button("Anuluj", role: .cancel) {}
        } message: { device in
            Text("\(device.name) traci dostęp od razu.")
        }
    }

    /// The phone's own key and (servers since step 1) the server's record of it.
    private var hasBolusKey: Bool {
        container.thisPhoneHasLocalBolusKey && viewModel.thisDevice?.has_bolus_key != false
    }

    private var bolusKeyText: String {
        if hasBolusKey { return "Jest" }
        return DeviceBiometrics.isAvailable ? "Brak" : "Niedostępny"
    }

    private var bolusKeyFooter: String {
        if hasBolusKey { return "Klucz do bolusa powstał przy potwierdzeniu zdalnego bolusa i działa tylko z Face ID tego telefonu. Nie opuszcza telefonu." }
        if !DeviceBiometrics.isAvailable { return "Ten telefon nie ma Face ID ani Touch ID: działa wszystko poza zdalnym bolusem." }
        return "Klucz do bolusa powstaje, gdy potwierdzisz zdalny bolus u pacjenta (Face ID). Do połączenia telefonu nie jest potrzebny."
    }

    private func repair() {
        isRepairing = true
        repairMessage = nil
        Task {
            defer { isRepairing = false }
            do {
                try await container.repairThisPhone()
                repairMessage = "Połączono ponownie. Nowy klucz telefonu działa."
                await viewModel.load()
            } catch let error as DeviceKeyError {
                repairMessage = error.message
            } catch {
                repairMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się połączyć ponownie."
            }
        }
    }
}

struct DeviceRow: View {
    let device: PairedDevice

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(device.name)
                if device.this_device { SharingBadge(text: "Ten telefon", prominent: true) }
            }
            Text(DeviceText.lastSeen(device))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

enum DeviceText {
    static func lastSeen(_ device: PairedDevice) -> String {
        if let seen = device.last_seen_at.flatMap(ServerDate.parse) {
            return "Ostatnio: \(RemoteCommandFormat.dayAndTime(seen))"
        }
        if let created = ServerDate.parse(device.created_at) {
            return "Połączony: \(RemoteCommandFormat.dayAndTime(created))"
        }
        return ""
    }

    static func count(_ count: Int) -> String {
        switch count {
        case 0: return "Brak połączonych telefonów"
        case 1: return "1 telefon"
        case 2...4: return "\(count) telefony"
        default: return "\(count) telefonów"
        }
    }
}

/// "Dołącz": an invitation from another patient's owner, on a phone already paired with this server.
struct JoinInvitationView: View {
    let initialText: String
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var isWorking = false
    @State private var error: String?
    @State private var joined: String?

    var body: some View {
        NavigationStack {
            Form {
                if let joined {
                    Section {
                        Label("Dołączono: \(joined)", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(Brand.interactive)
                    } footer: {
                        Text("Przełączasz pacjentów strzałką przy imieniu na górze ekranu.")
                    }
                } else {
                    Section {
                        TextField("Link albo kod zaproszenia", text: $text, axis: .vertical)
                            .lineLimit(1...4)
                            .font(.callout.monospaced())
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .accessibilityIdentifier("join.code")
                        PasteButton(payloadType: String.self) { strings in
                            if let first = strings.first { text = first }
                        }
                        .labelStyle(.titleAndIcon)
                    } header: {
                        Text("Zaproszenie")
                    } footer: {
                        Text("Zaproszenie od właściciela innego pacjenta na tym samym serwerze. Twoje imię i telefony zostają bez zmian.")
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
                            join()
                        } label: {
                            HStack {
                                Spacer()
                                if isWorking { ProgressView() } else { Text("Dołącz").fontWeight(.semibold) }
                                Spacer()
                            }
                        }
                        .disabled(isWorking || code == nil)
                        .accessibilityIdentifier("join.accept")
                    }
                }
            }
            .navigationTitle("Dołącz")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: joined == nil ? .cancellationAction : .confirmationAction) {
                    Button(joined == nil ? "Anuluj" : "Gotowe") {
                        container.incomingPairingLink = nil
                        dismiss()
                    }
                }
            }
            .onAppear { if text.isEmpty { text = initialText } }
        }
    }

    /// The code from a pasted link (of this server) or the code alone.
    private var code: String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().contains("\(PairingLink.scheme)://") {
            guard case let .success(link) = PairingLink.parse(trimmed, allowsInsecureHTTP: AppContainer.allowsInsecureServer) else { return nil }
            if let server = container.pairing?.serverURL, !link.isSameServer(as: server) { return nil }
            return link.code
        }
        return OneTimeCode.isPlausible(trimmed) ? trimmed : nil
    }

    private func join() {
        guard let code else { return }
        isWorking = true
        error = nil
        Task {
            defer { isWorking = false }
            do {
                joined = try await container.acceptInvitation(code: code)
            } catch {
                self.error = DeviceAuthErrorText.message(for: error) ?? "Nie udało się dołączyć."
            }
        }
    }
}

/// Ustawienia → "Dodaj pacjenta": a patient with their own Nightscout; the owner adding them owns them, and so do the
/// co-owners picked in "Dodaj też współwłaścicieli".
struct AddPatientView: View {
    @StateObject var viewModel: AddPatientViewModel
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section("Pacjent") {
                TextField("Imię", text: $viewModel.displayName)
                    .accessibilityIdentifier("addPatient.name")
                Picker("Rok urodzenia", selection: $viewModel.birthYear) {
                    Text("Wybierz").tag(Int?.none)
                    ForEach(viewModel.years, id: \.self) { year in
                        Text(String(year)).tag(Int?.some(year))
                    }
                }
            }
            Section {
                TextField("https://nightscout.example.pl", text: $viewModel.nightscoutURL)
                    .keyboardTypeURL()
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("addPatient.nightscout")
                SecureField("Token tylko do odczytu", text: $viewModel.token)
                    .accessibilityIdentifier("addPatient.token")
            } header: {
                Text("Nightscout")
            } footer: {
                Text("Token z rolą readable (Nightscout → Admin Tools → Subjects). Token z prawem zapisu zostanie odrzucony. Serwer sprawdzi połączenie i ostatni odczyt glukozy.")
            }
            if !viewModel.coOwnerCandidates.isEmpty {
                Section {
                    ForEach(viewModel.coOwnerCandidates) { person in
                        Toggle(isOn: Binding(
                            get: { viewModel.selectedCoOwnerIDs.contains(person.user_id) },
                            set: { _ in viewModel.toggleCoOwner(person.user_id) }
                        )) {
                            HStack(spacing: 12) {
                                SettingsAvatar(patientID: person.user_id, name: person.display_name, size: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.display_name)
                                    Text(person.detail)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .tint(Brand.interactive)
                        .accessibilityIdentifier("addPatient.coOwner.\(person.display_name)")
                    }
                } header: {
                    Text("Dodaj też współwłaścicieli")
                } footer: {
                    Text("Właściciele Twoich innych pacjentów. Zobaczą wszystko, zaproszą kolejne osoby i zmienią uprawnienia. Zdalnego bolusa nie dostają: włącza się go osobno dla każdej osoby i każda potwierdza go na swoim telefonie.")
                }
            } else if viewModel.coOwnersUnavailable {
                Section {
                    SettingsErrorRow(message: "Nie udało się wczytać współwłaścicieli. Pacjent zostanie dodany tylko dla Ciebie; innych zaprosisz potem.")
                }
            }
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            Section {
                Button {
                    Task {
                        if let patientID = await viewModel.save() {
                            await container.patientAdded(patientID)
                            dismiss()
                        }
                    }
                } label: {
                    HStack {
                        Spacer()
                        if viewModel.isSaving { ProgressView() } else { Text("Dodaj pacjenta").fontWeight(.semibold) }
                        Spacer()
                    }
                }
                .disabled(!viewModel.canSave)
            } footer: {
                Text(viewModel.selectedCoOwnerIDs.isEmpty
                     ? "Zostajesz właścicielem nowego pacjenta. Innych opiekunów zaprosisz potem w Osoby i udostępnianie."
                     : "Zostajesz właścicielem nowego pacjenta razem z zaznaczonymi osobami. Innych opiekunów zaprosisz potem w Osoby i udostępnianie.")
            }
        }
        .task { await viewModel.loadCoOwners() }
        .navigationTitle("Dodaj pacjenta")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
