import SwiftUI
import GlucoMindCore

// Settings behind the gear, in the iOS Settings style. Everything about one patient lives on that patient's page
// (profile, Nightscout and the loop, people and sharing, remote bolus, this phone's notifications about them); this
// phone's own things live apart (the person and the server, the lock screen, the instructions for Mellis); then Mellis
// itself (the manual, privacy, about the app).
//
// Ustawienia
// ├─ <imię> · ten telefon · <serwer>                         › Ten telefon
// ├─ PACJENCI: <pacjent> · rok · pętla · ostatni odczyt      › strona pacjenta; + Dodaj pacjenta; Dołącz kodem
// ├─ TEN TELEFON: Ekran blokady i Dynamic Island ›, Instrukcje dla Mellis ›
// └─ MELLIS: Instrukcja obsługi (www), Przewodnik konfiguracji, Wesprzyj Mellis (www), Prywatność ›, O aplikacji ›

/// The settings sheet. `initialRoute` opens a page at once (Debug scenes for screenshots).
struct SettingsView: View {
    let apiClient: APIClient
    /// The patient whose tabs are on screen.
    let currentPatientID: String
    /// The capabilities of the patient on screen (kept live by the container); other patients read their own.
    @ObservedObject var currentCapabilities: PatientCapabilitiesStore
    /// Device mode: signs the remote bolus confirmation with this phone's bolus key; nil in the Cognito build.
    let signer: RemoteCommandSigning?
    /// This phone's id from the device registration (DeviceIDStore).
    let deviceID: String
    /// Registers this phone's push token again, for a device the server does not know yet.
    let onRegisterDevice: () async -> Void
    /// Nil hides "Odśwież ekran" (screens that refresh by pulling down).
    let onRefresh: (() -> Void)?
    let onClose: () -> Void
    var initialRoute: SettingsRoute? = nil

    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: SettingsPatientsModel
    @State private var path: [SettingsRoute] = []
    @State private var openedInitialRoute = false
    /// "Instrukcje dla Mellis"; nil until the server has answered (no row on a server without them).
    @State private var aiPreferences: UserAiPreferences?
    @State private var isJoinPresented = false

    init(apiClient: APIClient, currentPatientID: String, currentCapabilities: PatientCapabilitiesStore, signer: RemoteCommandSigning?, deviceID: String, deviceMode: Bool, onRegisterDevice: @escaping () async -> Void, onRefresh: (() -> Void)?, onClose: @escaping () -> Void, initialRoute: SettingsRoute? = nil) {
        self.apiClient = apiClient
        self.currentPatientID = currentPatientID
        self.currentCapabilities = currentCapabilities
        self.signer = signer
        self.deviceID = deviceID
        self.onRegisterDevice = onRegisterDevice
        self.onRefresh = onRefresh
        self.onClose = onClose
        self.initialRoute = initialRoute
        _model = StateObject(wrappedValue: SettingsPatientsModel(api: apiClient, deviceMode: deviceMode))
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                personSection
                patientsSection
                thisPhoneSection
                mellisSection
            }
            .settingsListStyle()
            .navigationTitle("Ustawienia")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.large)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Gotowe", action: onClose)
                }
            }
            .navigationDestination(for: SettingsRoute.self, destination: destination)
            .refreshable { await model.load(patients: container.accessiblePatients) }
            .task {
                model.localBolusKey = { [container] in container.thisPhoneHasLocalBolusKey }
                async let summaries: Void = model.load(patients: container.accessiblePatients)
                aiPreferences = try? await apiClient.getUserAiPreferences()
                await summaries
            }
            .onAppear {
                guard !openedInitialRoute, let initialRoute else { return }
                openedInitialRoute = true
                if case let .remoteBolus(patientID) = initialRoute {
                    path = [.patient(patientID), initialRoute]
                } else {
                    path = [initialRoute]
                }
            }
            .sheet(isPresented: $isJoinPresented, onDismiss: { Task { await model.load(patients: container.accessiblePatients) } }) {
                JoinInvitationView(initialText: "")
            }
        }
    }

    // MARK: Root sections

    /// The person and this phone: "Ewa · Ten telefon · mellis.example" › Ten telefon.
    private var personSection: some View {
        Section {
            NavigationLink(value: SettingsRoute.thisPhone) {
                HStack(spacing: 14) {
                    SettingsAvatar(name: personName, fill: Brand.deepTeal, size: 52)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(personName)
                            .font(.title3.weight(.semibold))
                        Text(["Ten telefon", serverHost].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            }
            .accessibilityIdentifier("settings.thisPhone")
        }
    }

    private var patientsSection: some View {
        Section {
            ForEach(container.accessiblePatients, id: \.patient_id) { patient in
                NavigationLink(value: SettingsRoute.patient(patient.patient_id)) {
                    PatientRow(
                        patient: patient,
                        summary: model.summaries[patient.patient_id],
                        isOnScreen: patient.patient_id.lowercased() == currentPatientID.lowercased()
                    )
                }
                .accessibilityIdentifier("settings.patient.\(patient.display_name)")
            }
            if container.isDeviceMode {
                if model.ownsAnyPatient != false {
                    NavigationLink(value: SettingsRoute.addPatient) {
                        SettingsRowLabel(title: "Dodaj pacjenta", systemImage: "plus", tint: SettingsColor.add)
                    }
                    .accessibilityIdentifier("settings.addPatient")
                }
                Button {
                    isJoinPresented = true
                } label: {
                    SettingsRowLabel(title: "Dołącz kodem zaproszenia", systemImage: "person.badge.key.fill", tint: SettingsColor.join)
                }
                .accessibilityIdentifier("settings.join")
            }
        } header: {
            Text("Pacjenci")
        } footer: {
            if container.isDeviceMode {
                Text("Wszystko o pacjencie jest na jego stronie: profil, Nightscout, osoby, zdalny bolus i powiadomienia. Dołącz: kod zaproszenia od właściciela innego pacjenta na tym serwerze.")
            }
        }
    }

    private var thisPhoneSection: some View {
        Section {
            NavigationLink(value: SettingsRoute.lockScreen) {
                SettingsRowLabel(title: "Ekran blokady i Dynamic Island", subtitle: lockScreenSubtitle, systemImage: "lock.iphone", tint: SettingsColor.lockScreen)
            }
            .accessibilityIdentifier("settings.lockScreen")
            if let aiPreferences {
                NavigationLink(value: SettingsRoute.aiInstructions) {
                    SettingsRowLabel(title: "Instrukcje dla Mellis", subtitle: aiPreferences.summary, systemImage: "text.bubble.fill", tint: SettingsColor.assistant)
                }
                .accessibilityIdentifier("settings.aiInstructions")
            }
        } header: {
            Text("Ten telefon")
        } footer: {
            Text("Ekran blokady działa na tym telefonie. Instrukcje dla Mellis są Twoje: działają u każdego pacjenta i na każdym Twoim telefonie.")
        }
    }

    private var mellisSection: some View {
        Section {
            Link(destination: SettingsLinks.manual) {
                HStack {
                    SettingsRowLabel(title: "Instrukcja obsługi", systemImage: "book.fill", tint: SettingsColor.manual)
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .accessibilityIdentifier("settings.manual")
            if container.currentPatient != nil {
                Button {
                    container.openSetupGuideFromSettings()
                } label: {
                    SettingsRowLabel(title: SetupGuideText.settingsEntry, subtitle: "Zdalny bolus, powiadomienia, instrukcje", systemImage: "checklist", tint: SettingsColor.manual)
                }
                .accessibilityIdentifier("settings.setupGuide")
            }
            Link(destination: SettingsLinks.support) {
                HStack {
                    SettingsRowLabel(title: "Wesprzyj Mellis", subtitle: "Dobrowolnie, nie odblokowuje funkcji", systemImage: "heart.fill", tint: SettingsColor.support)
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .accessibilityIdentifier("settings.support")
            NavigationLink(value: SettingsRoute.privacy) {
                SettingsRowLabel(title: "Prywatność", systemImage: "hand.raised.fill", tint: SettingsColor.about)
            }
            .accessibilityIdentifier("settings.privacy")
            NavigationLink(value: SettingsRoute.about) {
                SettingsRowLabel(title: "O aplikacji", subtitle: AppBuildInfo.current.displayText, systemImage: "info", tint: SettingsColor.about)
            }
            .accessibilityIdentifier("settings.about")
        } header: {
            Text("Mellis")
        }
    }

    // MARK: Pages

    @ViewBuilder
    private func destination(_ route: SettingsRoute) -> some View {
        switch route {
        case let .patient(patientID):
            if let patient = container.accessiblePatients.first(where: { $0.patient_id == patientID }) {
                PatientSettingsView(
                    patient: patient,
                    apiClient: apiClient,
                    model: model,
                    isOnScreen: patient.patient_id.lowercased() == currentPatientID.lowercased(),
                    currentCapabilities: currentCapabilities,
                    signer: signer,
                    deviceID: deviceID,
                    onRegisterDevice: onRegisterDevice
                )
            } else {
                ContentUnavailableView("Brak pacjenta", systemImage: "person.slash")
            }
        case let .remoteBolus(patientID):
            if let patient = container.accessiblePatients.first(where: { $0.patient_id == patientID }) {
                RemoteBolusSettingsView(
                    patient: patient,
                    apiClient: apiClient,
                    model: model,
                    capabilities: patient.patient_id.lowercased() == currentPatientID.lowercased() ? currentCapabilities : nil,
                    sharing: container.showsRemoteBolusGrant ? DeviceSharingViewModel(patientID: patient.patient_id, patientName: patient.display_name, api: apiClient, signer: signer, acknowledgement: UserDefaultsDIYAcknowledgementStore()) : nil
                )
            }
        case .thisPhone:
            if container.isDeviceMode {
                ThisPhoneView(viewModel: ThisPhoneViewModel(api: apiClient))
            } else {
                AccountPhoneView(serverHost: serverHost, onClose: onClose)
            }
        case .lockScreen:
            LockScreenSettingsView(patients: container.accessiblePatients, currentPatientID: currentPatientID)
        case .aiInstructions:
            if let aiPreferences {
                AiPreferencesEditView(preferences: aiPreferences) { edited in
                    self.aiPreferences = try await apiClient.setUserAiPreferences(edited)
                }
            }
        case .about:
            AboutSettingsView(apiClient: apiClient, serverHost: serverHost, onRefresh: onRefresh.map { refresh in { onClose(); refresh() } })
        case .privacy:
            PrivacySettingsView()
        case .addPatient:
            AddPatientView(viewModel: AddPatientViewModel(api: apiClient))
        }
    }

    // MARK: Texts

    private var personName: String {
        let name = container.pairing?.displayName ?? container.userDisplayName
        return name?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? name! : "Ten telefon"
    }

    private var serverHost: String? {
        let url = container.pairing?.serverURL ?? apiClient.baseURL
        return url.host ?? url.absoluteString
    }

    private var lockScreenSubtitle: String {
        let controller = LiveActivityController.shared
        guard controller.isEnabled else { return "Wyłączone" }
        return controller.shownNames.map { "Włączone: \($0)" } ?? "Włączone"
    }
}

enum SettingsLinks {
    static let manual = MellisDocs.manual
    static let privacy = URL(string: "pomoc/prywatnosc/", relativeTo: manual)!.absoluteURL
    static let licence = URL(string: "https://www.gnu.org/licenses/agpl-3.0.html")!
    /// Voluntary support of the project (suppi.pl): unlocks nothing, opens in the browser.
    static let support = URL(string: "https://suppi.pl/mellis")!
}

/// A patient in the list: avatar, name, "2019 · Trio · ostatni odczyt 3 min temu".
private struct PatientRow: View {
    let patient: AccessiblePatient
    let summary: PatientSettingsSummary?
    let isOnScreen: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            HStack(spacing: 14) {
                SettingsAvatar(patientID: patient.patient_id, name: patient.display_name, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(patient.display_name)
                            .foregroundStyle(.primary)
                        if isOnScreen { SharingBadge(text: "Na ekranie", prominent: true) }
                    }
                    let subtitle = SettingsText.patientSubtitle(birthYear: patient.birth_year, loop: summary?.loop, lastReadingAt: summary?.lastReadingAt, now: context.date)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - The patient's page

/// Everything about one patient: profile, Nightscout and the loop, people and sharing, remote bolus, and this phone's
/// notifications about them.
struct PatientSettingsView: View {
    let patient: AccessiblePatient
    let apiClient: APIClient
    @ObservedObject var model: SettingsPatientsModel
    let isOnScreen: Bool
    let currentCapabilities: PatientCapabilitiesStore
    let signer: RemoteCommandSigning?
    let deviceID: String
    let onRegisterDevice: () async -> Void

    @EnvironmentObject private var container: AppContainer

    private var summary: PatientSettingsSummary? { model.summaries[patient.patient_id] }
    private var current: AccessiblePatient {
        container.accessiblePatients.first { $0.patient_id == patient.patient_id } ?? patient
    }
    /// The year of birth: only owners change it in device mode; the Cognito build as before.
    private var canEditBirthYear: Bool {
        current.supportsBirthYear && (!container.isDeviceMode || summary?.isOwner == true)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            List {
                header
                if let inbox = container.handoffInbox {
                    HandoffInboxSection(inbox: inbox, patientID: current.patient_id)
                }
                profileSection
                nightscoutSection(now: context.date)
                careSection
                PatientNotificationSection(
                    viewModel: DeviceNotificationSettingsViewModel(apiClient: apiClient, patientID: patient.patient_id, deviceID: deviceID, registerDevice: onRegisterDevice),
                    patientName: current.display_name
                )
                .id(patient.patient_id)
                if !isOnScreen {
                    Section {
                        Button {
                            container.selectPatient(current)
                        } label: {
                            SettingsRowLabel(title: "Pokaż pacjenta: \(current.display_name)", systemImage: "arrow.right.circle.fill", tint: SettingsColor.patient)
                        }
                    } footer: {
                        Text("Dashboard, rozmowy, posiłki i bolus tego pacjenta. Przełączasz też strzałką przy imieniu na górze ekranu.")
                    }
                }
            }
            .settingsListStyle()
        }
        .navigationTitle(current.display_name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .refreshable {
            await model.load(patient: current)
            await container.handoffInbox?.refresh()
        }
        .task {
            await model.load(patient: current)
            await container.handoffInbox?.refresh()
        }
    }

    private var header: some View {
        Section {
            VStack(spacing: 8) {
                SettingsAvatar(patientID: current.patient_id, name: current.display_name, size: 72)
                Text(current.display_name)
                    .font(.title2.weight(.bold))
                let detail = [current.birth_year.map { "Rok urodzenia \($0)" }, summary?.loop?.displayName].compactMap { $0 }.joined(separator: " · ")
                if !detail.isEmpty {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .listRowBackground(Color.clear)
            .accessibilityElement(children: .combine)
        }
    }

    private var profileSection: some View {
        Section {
            SettingsValueRow(title: "Imię", value: current.display_name, systemImage: "person.fill", tint: SettingsColor.profile)
            if canEditBirthYear {
                NavigationLink {
                    PatientBirthYearEditView(patientName: current.display_name, birthYear: current.birth_year) { year in
                        try await container.saveBirthYear(year, patientID: current.patient_id)
                    }
                } label: {
                    SettingsValueRow(title: "Rok urodzenia", value: current.birth_year.map(String.init) ?? "Nie podano", systemImage: "calendar", tint: SettingsColor.profile)
                }
            } else if current.supportsBirthYear || current.birth_year != nil {
                SettingsValueRow(title: "Rok urodzenia", value: current.birth_year.map(String.init) ?? "Nie podano", systemImage: "calendar", tint: SettingsColor.profile)
            }
        } header: {
            Text("Profil")
        } footer: {
            if container.isDeviceMode && summary?.isOwner == false {
                Text("Rok urodzenia zmienia właściciel. AI podaje z niego wiek pacjenta.")
            } else {
                Text("AI podaje z roku urodzenia wiek pacjenta.")
            }
        }
    }

    private func nightscoutSection(now: Date) -> some View {
        Section {
            if let host = summary?.nightscout?.host {
                SettingsValueRow(title: "Adres", value: host, systemImage: "link", tint: SettingsColor.nightscout)
            }
            let reading = summary?.lastReadingAt
            SettingsValueRow(
                title: "Połączenie",
                value: reading.map { SettingsText.relativeCapitalized($0, now: now) } ?? (summary?.isLoaded == true ? "Brak odczytów" : "Sprawdzam…"),
                systemImage: "dot.radiowaves.left.and.right",
                tint: SettingsColor.nightscout,
                valueColor: summary?.isLoaded == true && SettingsText.isStale(reading, now: now) ? BrandTint.amber.glyph : .secondary
            )
            SettingsValueRow(title: "Pętla", value: summary?.loop?.displayName ?? "Nie rozpoznano", systemImage: "arrow.triangle.2.circlepath", tint: SettingsColor.loop)
        } header: {
            Text("Nightscout")
        } footer: {
            if summary?.isLoaded == true, SettingsText.isStale(summary?.lastReadingAt, now: now) {
                Text("Od ponad 15 minut brak nowego odczytu glukozy w Nightscoucie. Sprawdź telefon pacjenta, sensor i aplikację pętli.")
            } else {
                Text("Połączenie: czas ostatniego odczytu glukozy. Pętla rozpoznana z danych w Nightscout.")
            }
        }
    }

    private var careSection: some View {
        Section {
            if container.isDeviceMode {
                NavigationLink {
                    DeviceSharingView(
                        viewModel: DeviceSharingViewModel(patientID: current.patient_id, patientName: current.display_name, api: apiClient, signer: signer, acknowledgement: UserDefaultsDIYAcknowledgementStore()),
                        handoff: HandoffOwnerModel(
                            patientID: current.patient_id, patientName: current.display_name,
                            sender: container.makeHandoffSender(), api: apiClient,
                            sendsToLoop: { [model, current] in model.summaries[current.patient_id]?.remoteCommands?.sendsToLoop }
                        ),
                        onLeft: {
                            container.isSettingsPresented = false
                            Task { await container.refreshPatientEntry() }
                        }
                    )
                } label: {
                    SettingsRowLabel(title: "Osoby i udostępnianie", subtitle: summary?.peopleSubtitle, systemImage: "person.2.fill", tint: SettingsColor.people)
                }
                .accessibilityIdentifier("patient.people")
            }
            NavigationLink(value: SettingsRoute.remoteBolus(current.patient_id)) {
                SettingsRowLabel(title: "Zdalny bolus", subtitle: summary?.remoteBolusSubtitle(deviceMode: container.isDeviceMode), systemImage: "syringe.fill", tint: SettingsColor.remoteBolus)
            }
            .accessibilityIdentifier("patient.remoteBolus")
        }
    }
}

/// "Powiadomienia: Zosia": the optional pushes about one patient on this phone. Rescue carbs alerts (rescue-carbs.v1) are
/// off by default; the push when an answer is ready and the low reservoir push (reservoir-alerts.v1) are on by default.
/// The setup guide shows only the switches the person's access uses (glucose pushes, the AI's answer push).
struct PatientNotificationSection: View {
    @StateObject var viewModel: DeviceNotificationSettingsViewModel
    let patientName: String
    /// "Glukoza i alarmy": the low glucose warnings and the reservoir.
    var glucoseAlerts = true
    /// "Rozmowy z AI i posiłki": "Gotowa odpowiedź".
    var answerReady = true

    var body: some View {
        Section {
            if glucoseAlerts {
                SettingsToggleRow(
                    title: "Ostrzeżenia o możliwym hipo",
                    detail: "Gdy glukoza może spaść poniżej 70, z propozycją dosłodzenia.",
                    systemImage: "exclamationmark.triangle.fill",
                    tint: SettingsColor.notifications,
                    isOn: Binding(get: { viewModel.rescueCarbAlertsEnabled }, set: { enabled in Task { await viewModel.setRescueCarbAlertsEnabled(enabled) } })
                )
                .disabled(!viewModel.isLoaded || viewModel.isSaving)
            }
            if answerReady {
                SettingsToggleRow(
                    title: "Gotowa odpowiedź",
                    detail: "Gdy odpowiedź na Twoje pytanie jest gotowa, a aplikacja jest zamknięta lub w tle.",
                    systemImage: "bubble.left.and.text.bubble.right.fill",
                    tint: SettingsColor.notifications,
                    isOn: Binding(get: { viewModel.answerReadyPushEnabled }, set: { enabled in Task { await viewModel.setAnswerReadyPushEnabled(enabled) } })
                )
                .disabled(!viewModel.isLoaded || viewModel.isSaving)
            }
            if glucoseAlerts && viewModel.hasReservoirPush {
                SettingsToggleRow(
                    title: "Zbiornik insuliny",
                    detail: "Gdy insuliny w zbiorniku zostało na mniej niż dobę i drugi raz na mniej niż 8 godzin.",
                    systemImage: "drop.fill",
                    tint: SettingsColor.notifications,
                    isOn: Binding(get: { viewModel.reservoirPushEnabled }, set: { enabled in Task { await viewModel.setReservoirPushEnabled(enabled) } })
                )
                .disabled(!viewModel.isLoaded || viewModel.isSaving)
            }
            if let errorMessage = viewModel.errorMessage {
                HStack {
                    SettingsErrorRow(message: errorMessage)
                    Spacer()
                    if !viewModel.isLoaded {
                        Button("Ponów") { Task { await viewModel.load() } }
                            .font(.footnote)
                            .buttonStyle(.borderless)
                    }
                }
            }
        } header: {
            Text("Powiadomienia: \(patientName)")
        } footer: {
            Text("\(SettingsText.onThisPhone) Każdy telefon i każdy opiekun ma własne ustawienia.")
        }
        .task { await viewModel.load() }
    }
}

// MARK: - Remote bolus of one patient

/// "Zdalny bolus" of one patient: whether this person may give it and this phone can sign it (device mode: the grant,
/// its confirmation with Face ID that creates the bolus key, a phone without biometrics), and the loop's remote control
/// settings on this phone.
struct RemoteBolusSettingsView: View {
    let patient: AccessiblePatient
    let apiClient: APIClient
    @ObservedObject var model: SettingsPatientsModel
    /// The patient on screen: the container's live store; another patient: read here.
    let capabilities: PatientCapabilitiesStore?
    @StateObject private var ownCapabilities = PatientCapabilitiesStore()
    /// Device mode only; made once for this page (a parent's re-render must not drop what it read).
    @State private var sharing: DeviceSharingViewModel?

    init(patient: AccessiblePatient, apiClient: APIClient, model: SettingsPatientsModel, capabilities: PatientCapabilitiesStore?, sharing: @autoclosure () -> DeviceSharingViewModel?) {
        self.patient = patient
        self.apiClient = apiClient
        self.model = model
        self.capabilities = capabilities
        _sharing = State(initialValue: sharing())
    }

    var body: some View {
        RemoteBolusSettingsContent(
            patient: patient,
            apiClient: apiClient,
            model: model,
            capabilities: capabilities ?? ownCapabilities,
            sharing: sharing
        )
        .task {
            if capabilities == nil { await ownCapabilities.refresh(api: apiClient, patientID: patient.patient_id) }
        }
    }
}

private struct RemoteBolusSettingsContent: View {
    let patient: AccessiblePatient
    let apiClient: APIClient
    @ObservedObject var model: SettingsPatientsModel
    @ObservedObject var capabilities: PatientCapabilitiesStore
    let sharing: DeviceSharingViewModel?
    @EnvironmentObject private var container: AppContainer

    var body: some View {
        List {
            if let inbox = container.handoffInbox {
                HandoffInboxSection(inbox: inbox, patientID: patient.patient_id)
            }
            if let sharing {
                RemoteBolusPersonSection(sharing: sharing, model: model) {
                    await capabilities.refresh(api: apiClient, patientID: patient.patient_id)
                }
            }
            loopSection
        }
        .settingsListStyle()
        .navigationTitle("Zdalny bolus")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .refreshable {
            await capabilities.refresh(api: apiClient, patientID: patient.patient_id)
            await sharing?.load()
            await model.loadThisPhone()
            await container.handoffInbox?.refresh()
        }
        // On the list, not the section: an empty section (nothing read yet) is never put on screen.
        .task {
            await sharing?.load()
            await model.loadThisPhone()
            await container.handoffInbox?.refresh()
        }
    }

    private var loopSection: some View {
        Section {
            SettingsValueRow(title: "Pętla", value: capabilities.loopSystem.displayName ?? "Nie rozpoznano", systemImage: "arrow.triangle.2.circlepath", tint: SettingsColor.loop)
            if capabilities.remoteCommands.enabled {
                if capabilities.remoteCommands.sendsToLoop {
                    NavigationLink {
                        LoopRemoteSettingsView(
                            viewModel: LoopRemoteSettingsViewModel(patientID: patient.patient_id, patientName: patient.display_name, api: apiClient, store: KeychainLoopRemoteSettingsStore(), identity: .current())
                        )
                    } label: {
                        SettingsRowLabel(title: "Zdalne sterowanie Loop", subtitle: "Klucze i limity na tym telefonie", systemImage: "antenna.radiowaves.left.and.right", tint: SettingsColor.remoteBolus)
                    }
                } else {
                    NavigationLink {
                        TrioRemoteSettingsView(
                            viewModel: TrioRemoteSettingsViewModel(
                                patientID: patient.patient_id,
                                patientName: patient.display_name,
                                api: apiClient,
                                store: KeychainTrioRemoteSettingsStore(),
                                identity: .current(),
                                recentCommand: { [apiClient, patient] in
                                    try? await apiClient.listRemoteCommands(patientID: patient.patient_id, limit: 1).first
                                }
                            )
                        )
                    } label: {
                        SettingsRowLabel(title: "Zdalne sterowanie Trio", subtitle: "Klucze i limity na tym telefonie", systemImage: "antenna.radiowaves.left.and.right", tint: SettingsColor.remoteBolus)
                    }
                }
            } else {
                SettingsValueRow(title: "Zdalne polecenia", value: "Wyłączone", systemImage: "antenna.radiowaves.left.and.right", tint: SettingsColor.remoteBolus)
            }
        } header: {
            Text("Pętla i ten telefon")
        } footer: {
            if let sharing {
                RemoteBolusLoopFooter(sharing: sharing, capabilities: capabilities)
            } else {
                Text(RemoteBolusSettingsText.loopFooter(remoteCommands: capabilities.remoteCommands, isOwner: nil, grant: nil))
            }
        }
    }
}

/// "Pętla i ten telefon"'s footer in device mode: why commands are off reads the person's own grant (owner or not).
private struct RemoteBolusLoopFooter: View {
    @ObservedObject var sharing: DeviceSharingViewModel
    @ObservedObject var capabilities: PatientCapabilitiesStore

    var body: some View {
        Text(RemoteBolusSettingsText.loopFooter(
            remoteCommands: capabilities.remoteCommands,
            isOwner: sharing.people.map(\.you_are_owner),
            grant: sharing.people?.you?.remote_bolus.state
        ))
    }
}

/// Device mode: this person's grant for the patient and this phone's bolus key. An owner without a grant turns it on
/// here ("Włącz zdalny bolus dla siebie": grant + Face ID confirmation in one go), not in Osoby i udostępnianie.
private struct RemoteBolusPersonSection: View {
    @ObservedObject var sharing: DeviceSharingViewModel
    @ObservedObject var model: SettingsPatientsModel
    /// After a confirmation: the patient's capabilities ("Zdalne polecenia") are read again.
    let onConfirmed: () async -> Void

    private var you: PatientPerson? { sharing.people?.you }
    private var biometrics: Bool { DeviceBiometrics.isAvailable }
    private var action: RemoteBolusPersonAction {
        RemoteBolusSettingsText.personAction(isOwner: sharing.isOwner, state: you?.remote_bolus.state, phoneReady: phoneReady, biometrics: biometrics)
    }

    var body: some View {
        Section {
            if let notice = sharing.notice {
                Label(notice, systemImage: "checkmark.seal.fill")
                    .font(.footnote)
                    .foregroundStyle(Brand.interactive)
            }
            if let error = sharing.errorMessage {
                SettingsErrorRow(message: error)
            }
            switch you?.remote_bolus.state {
            case .none:
                if sharing.isLoading { ProgressView() }
            case .some(.off):
                SettingsValueRow(title: "Dla Ciebie", value: "Wyłączony", systemImage: "person.fill.xmark", tint: SettingsColor.unavailable)
            case .some(.awaitingConfirmation):
                SettingsValueRow(title: "Dla Ciebie", value: "Czeka na potwierdzenie", systemImage: "hourglass", tint: SettingsColor.remoteBolus, valueChip: .amber)
            case .some(.on):
                SettingsValueRow(title: "Dla Ciebie", value: "Włączony", systemImage: "checkmark.seal.fill", tint: SettingsColor.remoteBolus)
                SettingsValueRow(title: "Ten telefon", value: phoneKeyText, systemImage: "key.fill", tint: phoneReady ? SettingsColor.remoteBolus : .amber, valueColor: phoneReady ? .secondary : BrandTint.amber.glyph)
            }
            switch action {
            case .enableForSelf:
                primaryButton(title: RemoteBolusSettingsText.enableForSelfButton, identifier: "remoteBolus.enableForSelf") {
                    await sharing.enableRemoteBolusForSelf()
                }
            case .confirm:
                primaryButton(title: RemoteBolusSettingsText.confirmButton(patientName: sharing.patientName), identifier: "remoteBolus.confirm") {
                    await sharing.confirmRemoteBolus()
                }
            case .setUpThisPhone:
                primaryButton(title: RemoteBolusSettingsText.setUpThisPhoneButton, identifier: "remoteBolus.confirm") {
                    await sharing.confirmRemoteBolus()
                }
            case .none:
                EmptyView()
            }
        } header: {
            Text("Ty i ten telefon")
        } footer: {
            Text(RemoteBolusSettingsText.personFooter(isOwner: sharing.isOwner, state: you?.remote_bolus.state, phoneReady: phoneReady, biometrics: biometrics))
        }
    }

    /// The grant counts and this phone can sign: its own bolus key, and the server has it.
    private var phoneReady: Bool { model.thisPhoneHasBolusKey }

    private var phoneKeyText: String {
        if phoneReady { return "Gotowy (Face ID)" }
        return biometrics ? "Brak klucza do bolusa" : "Bez Face ID / Touch ID"
    }

    /// The page's one thing to do, full width (Face ID follows).
    private func primaryButton(title: String, identifier: String, run: @escaping () async -> Bool) -> some View {
        Button {
            Task {
                if await run() {
                    await model.loadThisPhone()
                    await onConfirmed()
                }
            }
        } label: {
            HStack(spacing: 8) {
                if sharing.isSaving {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: "faceid")
                }
                Text(title)
                    .multilineTextAlignment(.center)
            }
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Brand.interactive)
        .disabled(sharing.isSaving)
        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - This phone's pages

/// Ustawienia → Ekran blokady i Dynamic Island: the glucose Live Activity on this phone (live-activity.v1), for one or
/// two patients (migration 094).
struct LockScreenSettingsView: View {
    let patients: [AccessiblePatient]
    let currentPatientID: String
    @ObservedObject private var controller = LiveActivityController.shared
    @State private var isSaving = false

    /// The patients picked (still accessible), in order; the patient on screen before anything was picked.
    private var shownPatients: [AccessiblePatient] {
        let picked = controller.patientIDs.compactMap { id in patients.first { $0.patient_id.lowercased() == id.lowercased() } }
        if !picked.isEmpty { return picked }
        return [patients.first { $0.patient_id == currentPatientID } ?? patients.first].compactMap { $0 }
    }

    private var isTwo: Bool { shownPatients.count > 1 }

    var body: some View {
        List {
            Section {
                SettingsToggleRow(
                    title: "Glukoza na ekranie blokady",
                    detail: "Odczyt, trend, IOB i COB na ekranie blokady i w Dynamic Island, odświeżane co odczyt.",
                    systemImage: "lock.iphone",
                    tint: SettingsColor.lockScreen,
                    isOn: Binding(
                        get: { controller.isEnabled },
                        set: { enabled in
                            let chosen = shownPatients
                            guard !chosen.isEmpty else { return }
                            save { await controller.setEnabled(enabled, patients: chosen) }
                        }
                    )
                )
                .disabled(isSaving)
                .accessibilityIdentifier("lockScreen.toggle")
                if controller.isBlockedBySystem {
                    SettingsErrorRow(message: "Live Activities są wyłączone w Ustawieniach iPhone’a (Mellis → Live Activities).")
                }
                if let errorMessage = controller.errorMessage {
                    SettingsErrorRow(message: errorMessage)
                }
            } footer: {
                Text(SettingsText.onThisPhone)
            }
            if patients.count > 1 {
                patientsSection
            }
            islandSection
        }
        .settingsListStyle()
        .navigationTitle("Ekran blokady")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// One or two patients, each with their colour; a third cannot be picked.
    private var patientsSection: some View {
        let chosen = shownPatients
        return Section {
            ForEach(patients, id: \.patient_id) { patient in
                let index = chosen.firstIndex { $0.patient_id == patient.patient_id }
                let full = chosen.count >= LiveActivityController.maxPatients
                Button {
                    var next = chosen
                    if let index {
                        guard next.count > 1 else { return }
                        next.remove(at: index)
                    } else {
                        guard !full else { return }
                        next.append(patient)
                    }
                    save { await controller.setPatients(next) }
                } label: {
                    HStack(spacing: 12) {
                        SettingsAvatar(patientID: patient.patient_id, name: patient.display_name, size: 30)
                        Text(patient.display_name)
                            .foregroundStyle(index == nil && full ? Color.secondary : Color.primary)
                        Spacer()
                        if index != nil {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Brand.interactive)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // The only patient picked stays (the tap does nothing) without looking disabled.
                .disabled(isSaving || (index == nil && full))
                .accessibilityAddTraits(index != nil ? .isSelected : [])
                .accessibilityIdentifier("lockScreen.patient.\(patient.display_name)")
            }
        } header: {
            Text("Pacjenci")
        } footer: {
            Text("Jeden albo dwóch pacjentów. Dwóch widać obok siebie na ekranie blokady.")
        }
    }

    @ViewBuilder
    private var islandSection: some View {
        let chosen = shownPatients
        if chosen.count > 1 {
            Section {
                Picker("Dynamic Island", selection: Binding(
                    get: { controller.islandMode },
                    set: { mode in save { await controller.setIslandMode(mode) } }
                )) {
                    Text("Oboje").tag(LiveIslandMode.both)
                    Text("Bliższe zagrożeniu").tag(LiveIslandMode.closer)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .accessibilityIdentifier("lockScreen.islandMode")
                if controller.islandMode == .both {
                    let left = LiveIslandSides.assign(chosen.map(glance), left: controller.islandLeftPatientID)?.left.id ?? chosen[0].patient_id
                    Picker(selection: Binding(
                        get: { left },
                        set: { id in save { await controller.setIslandLeft(id) } }
                    )) {
                        ForEach(chosen, id: \.patient_id) { patient in
                            Text(patient.display_name).tag(patient.patient_id)
                        }
                    } label: {
                        SettingsRowLabel(title: "Po lewej", systemImage: "rectangle.lefthalf.inset.filled", tint: SettingsColor.lockScreen)
                    }
                    .accessibilityIdentifier("lockScreen.islandLeft")
                }
            } header: {
                Text("Dynamic Island")
            } footer: {
                Text(controller.islandMode == .both
                     ? "Po obu stronach wyspy glukoza i strzałka każdego pacjenta, bez IOB. \(SettingsText.onThisPhone)"
                     : "Wyspa pokazuje pacjenta bliższego zagrożeniu, z IOB: najpierw niska glukoza (poniżej 70 teraz albo za 15 minut według trendu), potem wysoka (powyżej 250), potem ten bliżej granic zakresu. \(SettingsText.onThisPhone)")
            }
            .disabled(isSaving)
        } else {
            Section {
                // iOS cannot hide a running Live Activity from the island: the choice is what it shows there.
                Picker("Dynamic Island", selection: Binding(
                    get: { controller.islandEnabled },
                    set: { withIOB in Task { await controller.setIslandEnabled(withIOB) } }
                )) {
                    Text("Glukoza i IOB").tag(true)
                    Text("Sama glukoza").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(!controller.isEnabled)
            } header: {
                Text("Dynamic Island")
            } footer: {
                Text("Co widać w wyspie obok aparatu u góry ekranu. \(SettingsText.onThisPhone)")
            }
        }
    }

    private func glance(_ patient: AccessiblePatient) -> LivePatientGlance {
        LivePatientGlance(id: patient.patient_id, name: patient.display_name, glucose: nil, direction: nil, delta: nil, readingAt: nil, iob: nil)
    }

    private func save(_ work: @escaping () async -> Void) {
        isSaving = true
        Task {
            await work()
            isSaving = false
        }
    }
}

/// The Cognito build's "Ten telefon": the account and the server, "Wyloguj".
private struct AccountPhoneView: View {
    let serverHost: String?
    let onClose: () -> Void
    @EnvironmentObject private var container: AppContainer
    @State private var isSignOutConfirmationPresented = false

    var body: some View {
        List {
            Section {
                if let name = container.userDisplayName {
                    SettingsValueRow(title: "Konto", value: name, systemImage: "person.crop.circle.fill", tint: SettingsColor.patient)
                }
                SettingsValueRow(title: "Telefon", value: AppContainer.deviceName, systemImage: "iphone", tint: SettingsColor.phone)
                if let serverHost {
                    SettingsValueRow(title: "Serwer", value: serverHost, systemImage: "server.rack", tint: SettingsColor.phone)
                }
            }
            if container.canSignOut {
                Section {
                    Button("Wyloguj", role: .destructive) {
                        isSignOutConfirmationPresented = true
                    }
                    .confirmationDialog("Wylogować się?", isPresented: $isSignOutConfirmationPresented, titleVisibility: .visible) {
                        Button("Wyloguj", role: .destructive) {
                            onClose()
                            Task { await container.signOut() }
                        }
                        Button("Anuluj", role: .cancel) {}
                    }
                } footer: {
                    Text("Ten telefon przestanie dostawać powiadomienia, dopóki się nie zalogujesz.")
                }
            }
        }
        .settingsListStyle()
        .navigationTitle("Ten telefon")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// Ustawienia → O aplikacji: the app's version and build, the server's (when it says), the licence.
struct AboutSettingsView: View {
    let apiClient: APIClient
    let serverHost: String?
    let onRefresh: (() -> Void)?
    @State private var serverVersion: String?

    var body: some View {
        List {
            Section {
                VStack(spacing: 8) {
                    HummingbirdMark(size: 64)
                    Text("Mellis")
                        .font(.title2.weight(.bold))
                    Text("Asystent opiekuna osoby z cukrzycą typu 1")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .listRowBackground(Color.clear)
            }
            Section {
                SettingsValueRow(title: "Wersja", value: AppBuildInfo.current.aboutText, systemImage: "app.badge", tint: SettingsColor.about)
                if let serverHost {
                    SettingsValueRow(title: "Serwer", value: serverHost, systemImage: "server.rack", tint: SettingsColor.about)
                }
                if let serverVersion {
                    SettingsValueRow(title: "Wersja serwera", value: serverVersion, systemImage: "server.rack", tint: SettingsColor.about)
                }
                Link(destination: SettingsLinks.licence) {
                    HStack {
                        SettingsValueRow(title: "Licencja", value: "AGPL-3.0", systemImage: "doc.text.fill", tint: SettingsColor.about)
                        Image(systemName: "arrow.up.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
            } footer: {
                Text("Mellis jest wolnym oprogramowaniem na licencji GNU AGPL-3.0. Nie zastępuje lekarza ani decyzji opiekuna.")
            }
            if let onRefresh {
                Section {
                    Button {
                        onRefresh()
                    } label: {
                        SettingsRowLabel(title: "Odśwież ekran", systemImage: "arrow.clockwise", tint: SettingsColor.about)
                    }
                } footer: {
                    Text("Wczytuje od nowa ekran, z którego otwarto ustawienia.")
                }
            }
        }
        .settingsListStyle()
        .navigationTitle("O aplikacji")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            serverVersion = (try? await apiClient.getAppConfig())?.server?.version
        }
    }
}

/// Ustawienia → Prywatność: a short summary of the privacy policy (docs-site pomoc/prywatnosc.md, keep both in step)
/// and the link to the full one.
struct PrivacySettingsView: View {
    private struct Part: Identifiable {
        let title: String
        let text: String
        var id: String { title }
    }

    private let parts: [Part] = [
        Part(
            title: "Kto odpowiada za dane",
            text: "Za dane odpowiada osoba albo rodzina, która uruchomiła swój serwer Mellis. Autorzy aplikacji Mellis nie mają do nich dostępu: nie ma centralnego serwera, kont u autorów, analityki ani telemetrii."
        ),
        Part(
            title: "Co jest na Twoim serwerze",
            text: "Kopia odczytów z Nightscouta, posiłki i ich zdjęcia, rozmowy, przypomnienia, podopieczni, opiekunowie, połączone telefony i historia zdalnych bolusów. Z Nightscouta Mellis tylko czyta, niczego tam nie zapisuje."
        ),
        Part(
            title: "Co dostaje dostawca AI",
            text: "Anthropic albo OpenAI, wybrany w instalatorze, dostaje Twoje pytanie, dane potrzebne do odpowiedzi, rok urodzenia podopiecznego i zdjęcia, które dołączysz. Bez imion, chyba że sam je wpiszesz. Dostawca przechowuje dane według swoich zasad."
        ),
        Part(
            title: "Powiadomienia i zdalny bolus",
            text: "Powiadomienia idą przez Apple i mogą zawierać glukozę, dawki, insulinę w zbiorniku oraz imiona. Polecenie zdalnego bolusu idzie z telefonu prosto do Trio albo Loopa. Klucze do zdalnego sterowania są tylko w pęku kluczy tego telefonu."
        ),
        Part(
            title: "Jak długo i jak usunąć",
            text: "Dane są na serwerze, dopóki ich nie usuniesz. Nocne kopie serwer trzyma 14 dni. Wszystko usuniesz na serwerze: mellis → Odinstaluj → Usuń wszystko. Klucz AI usuń też w konsoli dostawcy."
        ),
        Part(
            title: "Dane o zdrowiu",
            text: "To dane szczególnej kategorii, często osoby niepełnoletniej. Ty decydujesz, komu je powierzasz, i Ty za to odpowiadasz. To nie jest porada prawna."
        ),
    ]

    var body: some View {
        List {
            ForEach(parts) { part in
                Section {
                    Text(part.text)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                } header: {
                    Text(part.title)
                }
            }
            Section {
                Link(destination: SettingsLinks.privacy) {
                    HStack {
                        SettingsRowLabel(title: "Pełna polityka prywatności", systemImage: "doc.text.fill", tint: SettingsColor.about)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .accessibilityIdentifier("settings.privacy.full")
            } footer: {
                Text("Pytania o program zadawaj na GitHubie projektu. Autorzy nie mają Twoich danych, więc nie mogą ich wydać ani usunąć.")
            }
        }
        .settingsListStyle()
        .navigationTitle("Prywatność")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

// MARK: - Summaries of the patients

/// What the list and the patient's page show besides the patient itself.
struct PatientSettingsSummary: Equatable {
    var loop: LoopSystemInfo?
    var remoteCommands: RemoteCommandsAccess?
    var nightscout: NightscoutSummary?
    var lastReadingAt: Date?
    /// Device mode: from the people list (nil while unknown).
    var isOwner: Bool?
    var people: PatientPeopleResponse?
    var isLoaded = false

    var peopleSubtitle: String? {
        guard let people else { return nil }
        return PeopleCountText.count(people.people.count, invitations: people.invitations.count)
    }

    func remoteBolusSubtitle(deviceMode: Bool) -> String? {
        if deviceMode, let you = people?.you {
            switch you.remote_bolus.state {
            case .on: return remoteCommands?.enabled == true ? "Włączony" : "Włączony dla Ciebie"
            case .awaitingConfirmation: return "Czeka na Twoje potwierdzenie"
            case .off: return "Wyłączony"
            }
        }
        guard let remoteCommands else { return nil }
        return remoteCommands.enabled ? "Włączony" : "Wyłączony"
    }
}

enum PeopleCountText {
    static func count(_ people: Int, invitations: Int) -> String {
        let persons: String
        switch people {
        case 1: persons = "1 osoba"
        case 2...4: persons = "\(people) osoby"
        default: persons = "\(people) osób"
        }
        guard invitations > 0 else { return persons }
        return persons + (invitations == 1 ? " · 1 zaproszenie" : invitations < 5 ? " · \(invitations) zaproszenia" : " · \(invitations) zaproszeń")
    }
}

/// Reads, for each patient, its loop and remote control state, its Nightscout and newest reading, and (device mode) its
/// people; and whether this phone holds a registered bolus key.
@MainActor
final class SettingsPatientsModel: ObservableObject {
    @Published private(set) var summaries: [String: PatientSettingsSummary] = [:]
    /// This phone has its own bolus key and the server has it registered.
    @Published private(set) var thisPhoneHasBolusKey = false

    let api: APIClient
    let deviceMode: Bool
    /// Reads the phone's own bolus key (the container's key store); false without one.
    var localBolusKey: () -> Bool = { false }

    init(api: APIClient, deviceMode: Bool) {
        self.api = api
        self.deviceMode = deviceMode
    }

    /// False when every patient is known not to be owned (a helper: no "Dodaj pacjenta"); nil while unknown.
    var ownsAnyPatient: Bool? {
        let owners = summaries.values.compactMap(\.isOwner)
        if owners.contains(true) { return true }
        return owners.isEmpty || owners.count < summaries.count ? nil : false
    }

    func load(patients: [AccessiblePatient]) async {
        await withTaskGroup(of: Void.self) { group in
            for patient in patients {
                group.addTask { await self.load(patient: patient) }
            }
            group.addTask { await self.loadThisPhone() }
        }
    }

    func load(patient: AccessiblePatient) async {
        let id = patient.patient_id
        async let capabilities = try? api.getCapabilities(patientID: id)
        async let nightscout = deviceMode ? (try? api.nightscoutSummary(patientID: id)) : nil
        async let people = deviceMode ? (try? api.listPeople(patientID: id)) : nil
        var summary = summaries[id] ?? PatientSettingsSummary()
        let (readCapabilities, readNightscout, readPeople) = await (capabilities, nightscout, people)
        if let readCapabilities {
            summary.loop = readCapabilities.loop_system
            summary.remoteCommands = readCapabilities.remote_commands
        }
        if let readNightscout {
            summary.nightscout = readNightscout
            summary.lastReadingAt = readNightscout.last_reading_at.flatMap(ServerDate.parse)
        } else if let dashboard = try? await api.getDashboard(patientID: id) {
            // The Cognito build (no Nightscout summary route): the dashboard's newest reading.
            summary.lastReadingAt = dashboard.glucose.flatMap { ServerDate.parse($0.observed_at) }
        }
        if deviceMode {
            summary.people = readPeople ?? summary.people
            // A member with glucose only cannot read the people (403): not an owner.
            summary.isOwner = readPeople?.you_are_owner ?? false
        }
        summary.isLoaded = true
        summaries[id] = summary
    }

    func loadThisPhone() async {
        guard deviceMode else { return }
        let local = localBolusKey()
        guard local else {
            thisPhoneHasBolusKey = false
            return
        }
        // Servers before step 1 do not say: the local key counts.
        let server = (try? await api.listOwnDevices())?.first(where: \.this_device)?.has_bolus_key
        thisPhoneHasBolusKey = server ?? true
    }
}
