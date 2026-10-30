import SwiftUI
import UserNotifications
import GlucoMindCore
#if canImport(UIKit)
import UIKit
#endif

/// The guide on screen: who it is for and where it starts. `key` nil: reopened from Settings (or fixtures), no mark.
struct SetupGuideRequest: Identifiable {
    let id = UUID()
    let patient: AccessiblePatient
    let access: SetupGuideAccess
    let key: String?
    var startAt: SetupGuideStep? = nil
}

/// Reads what the person may use, for the steps of the guide (SetupGuideAccess). Every read may fail: a step that cannot
/// be confirmed is left out (remote bolus, the instructions), notifications always stay.
@MainActor
enum SetupGuideAccessLoader {
    static func load(api: APIClient, patientID: String, deviceMode: Bool, capabilities: PatientCapabilitiesStore, setUpOnThisPhone: Bool) async -> SetupGuideAccess {
        if capabilities.patientID?.lowercased() != patientID.lowercased() {
            _ = await capabilities.refresh(api: api, patientID: patientID)
        }
        var isOwner: Bool?
        var you: PatientPerson?
        var glucoseAlerts = true
        var assistant = true
        if deviceMode {
            do {
                let people = try await api.listPeople(patientID: patientID)
                isOwner = people.you_are_owner
                you = people.you
                if !people.you_are_owner, let permissions = you?.permissions {
                    glucoseAlerts = permissions.glucose_alerts
                    assistant = permissions.ai_chat_meals
                }
            } catch APIClientError.forbidden {
                // Only a member with glucose alone may not read the people.
                isOwner = false
                assistant = false
            } catch {
                NSLog("[SETUP-GUIDE] people read failed error=%@", String(describing: error))
            }
        }
        let hasAiPreferences = assistant ? ((try? await api.getUserAiPreferences()) != nil) : false
        let remote = SetupGuideAccess.allowsRemoteControl(
            deviceMode: deviceMode,
            isOwner: isOwner,
            grant: you?.remote_bolus.state,
            remoteCommands: capabilities.remoteCommands,
            setUpOnThisPhone: setUpOnThisPhone
        )
        return SetupGuideAccess(
            remoteControl: remote,
            loopSystem: capabilities.loopSystem.system,
            glucoseAlerts: glucoseAlerts,
            assistant: assistant,
            hasAiPreferences: hasAiPreferences
        )
    }
}

private enum SetupGuideRoute: Hashable {
    case remoteBolus
    case instructions
}

/// "Przewodnik konfiguracji": one page per step, each optional, with the Settings pages it opens.
struct SetupGuideView: View {
    @StateObject private var model: SetupGuideViewModel
    let patient: AccessiblePatient
    let apiClient: APIClient
    let onClose: () -> Void

    @EnvironmentObject private var container: AppContainer
    @StateObject private var settingsModel: SettingsPatientsModel
    @State private var path: [SetupGuideRoute] = []
    @State private var aiPreferences: UserAiPreferences?
    @State private var permission: UNAuthorizationStatus?
    @State private var isAskingPermission = false
    /// Made once: a re-render must not drop what the remote bolus page read.
    @State private var sharing: DeviceSharingViewModel?

    init(request: SetupGuideRequest, apiClient: APIClient, deviceMode: Bool, onClose: @escaping () -> Void) {
        _model = StateObject(wrappedValue: SetupGuideViewModel(
            access: request.access,
            patientName: request.patient.display_name,
            store: UserDefaultsSetupGuideSeenStore(),
            key: request.key,
            startAt: request.startAt
        ))
        self.patient = request.patient
        self.apiClient = apiClient
        self.onClose = onClose
        _settingsModel = StateObject(wrappedValue: SettingsPatientsModel(api: apiClient, deviceMode: deviceMode))
    }

    var body: some View {
        NavigationStack(path: $path) {
            page(model.current)
                .id(model.current)
                .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
                .navigationTitle("")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar { toolbar }
                .navigationDestination(for: SetupGuideRoute.self, destination: destination)
        }
        .tint(Brand.interactive)
        .onAppear {
            model.markShown()
            #if DEBUG
            // Screenshots of the "later" note: GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_POSTPONED=1.
            if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_POSTPONED"] == "1" { model.postpone() }
            #endif
        }
        .task {
            settingsModel.localBolusKey = { [container] in container.thisPhoneHasLocalBolusKey }
            if container.showsRemoteBolusGrant, sharing == nil {
                sharing = DeviceSharingViewModel(patientID: patient.patient_id, patientName: patient.display_name, api: apiClient, signer: container.deviceSigner, acknowledgement: UserDefaultsDIYAcknowledgementStore())
            }
            if model.steps.contains(.instructions) { aiPreferences = try? await apiClient.getUserAiPreferences() }
            await readPermission()
            #if DEBUG
            // Screenshots of "Skonfiguruj teraz" (step 1 → Zdalny bolus): GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_OPEN=remote.
            if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_OPEN"] == "remote", model.current == .remoteControl {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                openRemote()
            }
            #endif
        }
        .onChange(of: model.isClosed) { _, closed in
            if closed { onClose() }
        }
        #if canImport(UIKit)
        // Back from iOS Settings: the permission may have changed there.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { await readPermission() }
        }
        #endif
    }

    // MARK: Chrome

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            if model.canGoBack {
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) { model.back() }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left").font(.body.weight(.semibold))
                        Text("Wstecz")
                    }
                }
                .accessibilityIdentifier("setupGuide.back")
            }
        }
        ToolbarItem(placement: .principal) {
            if let progress = model.progress {
                SetupGuideProgress(number: progress.number, total: progress.total)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                model.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Color.secondary.opacity(0.14)))
            }
            .accessibilityLabel("Zamknij przewodnik")
            .accessibilityIdentifier("setupGuide.close")
        }
    }

    private func advance() {
        withAnimation(.easeInOut(duration: 0.25)) { model.next() }
    }

    private func postpone() {
        withAnimation(.easeOut(duration: 0.2)) { model.postpone() }
    }

    // MARK: Pages

    @ViewBuilder
    private func page(_ step: SetupGuideStep) -> some View {
        switch step {
        case .remoteControl:
            SetupGuidePage(
                systemImage: "syringe.fill",
                tint: SettingsColor.remoteBolus,
                title: SetupGuideText.remoteTitle(model.access.loopSystem),
                detail: SetupGuideText.remoteDetail(model.access.loopSystem, patientName: patient.display_name),
                note: model.isPostponed(.remoteControl) ? SetupGuideText.laterNote(.remoteControl, patientName: patient.display_name) : nil
            ) {
                EmptyView()
            } actions: {
                if model.isPostponed(.remoteControl) || model.wasOpened(.remoteControl) {
                    SetupGuidePrimaryButton(title: "Dalej", identifier: "setupGuide.next", action: advance)
                    if model.wasOpened(.remoteControl) {
                        SetupGuideSecondaryButton(title: "Wróć do ustawień", identifier: "setupGuide.remote.open") { openRemote() }
                    }
                } else {
                    SetupGuidePrimaryButton(title: "Skonfiguruj teraz", identifier: "setupGuide.remote.open") { openRemote() }
                    SetupGuideSecondaryButton(title: "Później", identifier: "setupGuide.later", action: postpone)
                }
            }
        case .notifications:
            SetupGuidePage(
                systemImage: "bell.badge.fill",
                tint: SettingsColor.notifications,
                title: SetupGuideText.notificationsTitle,
                detail: SetupGuideText.notificationsDetail,
                note: model.isPostponed(.notifications) ? SetupGuideText.laterNote(.notifications, patientName: patient.display_name) : nil
            ) {
                permissionSection
                if permission.map(Self.allowsAlerts) == true {
                    // The patient on screen (the access read is theirs); other patients have the same switches on their pages.
                    PatientNotificationSection(
                        viewModel: DeviceNotificationSettingsViewModel(apiClient: apiClient, patientID: patient.patient_id, deviceID: DeviceIDStore.shared.deviceID, registerDevice: { await container.registerDeviceAgain() }),
                        patientName: patient.display_name,
                        glucoseAlerts: model.access.glucoseAlerts,
                        answerReady: model.access.assistant
                    )
                }
            } actions: {
                SetupGuidePrimaryButton(title: "Dalej", identifier: "setupGuide.next", action: advance)
                if !model.isPostponed(.notifications) {
                    SetupGuideSecondaryButton(title: "Pomiń", identifier: "setupGuide.later", action: postpone)
                }
            }
        case .instructions:
            SetupGuidePage(
                systemImage: "text.bubble.fill",
                tint: SettingsColor.assistant,
                title: SetupGuideText.instructionsTitle,
                detail: SetupGuideText.instructionsDetail,
                note: model.isPostponed(.instructions) ? SetupGuideText.laterNote(.instructions, patientName: patient.display_name) : nil
            ) {
                Section {
                    Text(SetupGuideText.instructionsExample)
                        .font(.callout)
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let aiPreferences, !aiPreferences.isEmpty {
                        SettingsValueRow(title: "Ustawiono", value: aiPreferences.summary, systemImage: "text.bubble.fill", tint: SettingsColor.assistant)
                    }
                }
            } actions: {
                if model.isPostponed(.instructions) || model.wasOpened(.instructions) {
                    SetupGuidePrimaryButton(title: "Dalej", identifier: "setupGuide.next", action: advance)
                    if model.wasOpened(.instructions) {
                        SetupGuideSecondaryButton(title: "Popraw instrukcje", identifier: "setupGuide.instructions.open") { openInstructions() }
                    }
                } else {
                    SetupGuidePrimaryButton(title: "Napisz instrukcje", identifier: "setupGuide.instructions.open") { openInstructions() }
                    SetupGuideSecondaryButton(title: "Pomiń", identifier: "setupGuide.later", action: postpone)
                }
            }
        case .done:
            SetupGuidePage(
                systemImage: "checkmark",
                tint: SettingsColor.patient,
                title: SetupGuideText.doneTitle,
                detail: SetupGuideText.doneDetail,
                note: nil
            ) {
                EmptyView()
            } actions: {
                SetupGuidePrimaryButton(title: "Gotowe", identifier: "setupGuide.done") { model.close() }
            }
        }
    }

    @ViewBuilder
    private var permissionSection: some View {
        Section {
            switch permission {
            case .none:
                ProgressView()
            case .some(.notDetermined):
                Button {
                    Task { await askPermission() }
                } label: {
                    SettingsRowLabel(title: "Zezwól na powiadomienia", subtitle: "iOS zapyta o zgodę dla aplikacji Mellis.", systemImage: "bell.fill", tint: SettingsColor.notifications)
                }
                .disabled(isAskingPermission)
                .accessibilityIdentifier("setupGuide.notifications.allow")
            case .some(let status) where Self.allowsAlerts(status):
                SettingsValueRow(title: "Powiadomienia iOS", value: "Włączone", systemImage: "bell.fill", tint: SettingsColor.notifications)
            case .some:
                SettingsValueRow(title: "Powiadomienia iOS", value: "Wyłączone", systemImage: "bell.slash.fill", tint: SettingsColor.unavailable, valueColor: BrandTint.amber.glyph)
                #if canImport(UIKit)
                Button {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                } label: {
                    SettingsRowLabel(title: "Otwórz Ustawienia iOS", systemImage: "gear", tint: SettingsColor.phone)
                }
                .accessibilityIdentifier("setupGuide.notifications.iosSettings")
                #endif
            }
        } footer: {
            if let permission, !Self.allowsAlerts(permission), permission != .notDetermined {
                Text("Bez zgody iOS żadne powiadomienie nie dotrze. Włączysz ją w Ustawieniach iOS → Mellis → Powiadomienia.")
            }
        }
    }

    // MARK: Pushed pages

    @ViewBuilder
    private func destination(_ route: SetupGuideRoute) -> some View {
        switch route {
        case .remoteBolus:
            RemoteBolusSettingsView(
                patient: patient,
                apiClient: apiClient,
                model: settingsModel,
                capabilities: container.currentPatient?.patient_id.lowercased() == patient.patient_id.lowercased() ? container.capabilities : nil,
                sharing: sharing
            )
        case .instructions:
            AiPreferencesEditView(preferences: aiPreferences ?? UserAiPreferences()) { edited in
                aiPreferences = try await apiClient.setUserAiPreferences(edited)
            }
        }
    }

    private func openRemote() {
        model.didOpen(.remoteControl)
        path.append(.remoteBolus)
    }

    private func openInstructions() {
        model.didOpen(.instructions)
        path.append(.instructions)
    }

    // MARK: Permission

    private static func allowsAlerts(_ status: UNAuthorizationStatus) -> Bool {
        #if os(iOS)
        if status == .ephemeral { return true }
        #endif
        return status == .authorized || status == .provisional
    }

    private func readPermission() async {
        #if DEBUG
        // Screenshots: GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_PUSH=authorized|denied|notDetermined.
        if let raw = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_PUSH"] {
            permission = raw == "authorized" ? .authorized : raw == "denied" ? .denied : .notDetermined
            return
        }
        #endif
        permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func askPermission() async {
        isAskingPermission = true
        defer { isAskingPermission = false }
        await container.requestNotificationPermission()
        await readPermission()
    }
}

// MARK: - Pieces

/// "1/3" with one short bar per step, the done ones in the brand's teal.
private struct SetupGuideProgress: View {
    let number: Int
    let total: Int

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(1...total, id: \.self) { step in
                    Capsule()
                        .fill(step <= number ? Brand.interactive : Color.secondary.opacity(0.25))
                        .frame(width: 18, height: 4)
                }
            }
            Text("\(number)/\(total)")
                .font(.footnote.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(Color.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Krok \(number) z \(total)")
        .accessibilityIdentifier("setupGuide.progress")
    }
}

/// One step: a large tile, the title and a short text, the step's own rows, the "later" note, and its buttons at the
/// bottom of the screen.
private struct SetupGuidePage<Content: View, Actions: View>: View {
    let systemImage: String
    let tint: BrandTint
    let title: String
    let detail: String
    let note: String?
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions
    @ScaledMetric(relativeTo: .largeTitle) private var tile: CGFloat = 64

    var body: some View {
        List {
            Section {
                VStack(spacing: 14) {
                    Image(systemName: systemImage)
                        .font(.system(size: tile * 0.46, weight: .semibold))
                        .foregroundStyle(tint.glyph)
                        .frame(width: tile, height: tile)
                        .background(RoundedRectangle(cornerRadius: tile * 0.26, style: .continuous).fill(tint.background))
                        .accessibilityHidden(true)
                    Text(title)
                        .font(.title2.weight(.bold))
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("setupGuide.title")
                    Text(detail)
                        .font(.body)
                        .foregroundStyle(Color.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .listRowBackground(Color.clear)
            }
            content()
            if let note {
                Section {
                    Label {
                        Text(note)
                            .font(.callout)
                            .foregroundStyle(Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "gearshape.fill")
                            .foregroundStyle(BrandTint.slate.glyph)
                    }
                    .accessibilityIdentifier("setupGuide.note")
                }
            }
        }
        .settingsListStyle()
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 6) {
                actions()
            }
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(.bar)
        }
    }
}

private struct SetupGuidePrimaryButton: View {
    let title: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Brand.interactive)
        .accessibilityIdentifier(identifier)
    }
}

private struct SetupGuideSecondaryButton: View {
    let title: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderless)
        .tint(Brand.interactive)
        .accessibilityIdentifier(identifier)
    }
}
