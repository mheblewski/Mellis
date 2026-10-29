#if DEBUG
import SwiftUI
import GlucoMindCore

// DEBUG ONLY: simulator walkthroughs of device mode against a local server without tapping (screenshots for review,
// stage 4). Launch environment:
//   MELLIS_AUTO_PAIR=1          the pairing screen connects to an incoming link by itself after 4 s
//   MELLIS_UI_SCENE=<scene>     once the patient's tabs are on screen: sharing, invite, grant-self, this-phone,
//                               pair-another, add-patient, join, settings, send-bolus:<carbs>:<insulin>;
//                               Settings pages: settings-patient[:<name>], settings-remote-bolus[:<name>],
//                               settings-this-phone, settings-lock-screen, settings-about, settings-privacy, settings-add-patient
//   MELLIS_UI_PATIENT=<name>    with several patients, opens this one instead of the patient list
//   MELLIS_NO_BIOMETRICS=1      the phone acts as one without Face ID / Touch ID (DeviceBiometrics)
//   MELLIS_DEBUG_SEED_TRIO=<file> SIMULATOR ONLY: Trio settings typed in for the patient on screen from a JSON file
//                               ({ shared_secret, apns_key_id, apns_key_p8, max_bolus_u, max_carbs_g }; fake values and
//                               a throwaway key only), with the Trio Nightscout shows pinned and the limits reviewed
// Results (an invitation's link, a command's outcome) go to Documents/mellis-scene.log in the app's container.
// Face ID in the simulator: `xcrun simctl spawn <udid> notifyutil -p com.apple.BiometricKit_Sim.pearl.match`.
enum DeviceModeDebugScene: Identifiable, Equatable {
    case sharing, invite, grantSelf, thisPhone, pairAnother, addPatient, join
    case sendBolus(carbsG: Int, insulinU: Decimal)
    /// UI fixtures only (GLUCOMIND_UI_FIXTURES_OPEN=trio-settings): "Zdalne sterowanie Trio" from Settings.
    case trioSettings

    var id: String { String(describing: self) }

    static var autoPair: Bool { ProcessInfo.processInfo.environment["MELLIS_AUTO_PAIR"] == "1" }

    static var requested: String? { ProcessInfo.processInfo.environment["MELLIS_UI_SCENE"] }

    static func parse(_ raw: String) -> DeviceModeDebugScene? {
        let parts = raw.split(separator: ":").map(String.init)
        switch parts.first {
        case "sharing": return .sharing
        case "invite": return .invite
        case "grant-self": return .grantSelf
        case "this-phone": return .thisPhone
        case "pair-another": return .pairAnother
        case "add-patient": return .addPatient
        case "join": return .join
        case "send-bolus":
            guard parts.count == 3, let carbs = Int(parts[1]), let insulin = Decimal(string: parts[2]) else { return nil }
            return .sendBolus(carbsG: carbs, insulinU: insulin)
        default: return nil
        }
    }

    static func log(_ line: String) {
        NSLog("[UI-SCENE] %@", line)
        guard let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("mellis-scene.log") else { return }
        let data = Data((line + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}

extension AppContainer {
    /// UI fixtures (GLUCOMIND_UI_FIXTURES=1) only: GLUCOMIND_UI_FIXTURES_OPEN=conversations | conversation:<uuid> |
    /// settings | trio-settings opens that real screen once the patient's tabs show, the way a tap would (screenshots without tapping,
    /// e.g. the user documentation). The conversation UUIDs are the fixtures' push aliases.
    func openFixtureScreenIfRequested(patient: AccessiblePatient) async {
        guard ProcessInfo.processInfo.environment[UIPreviewFixtureHTTPClient.environmentKey] == "1",
              let raw = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_OPEN"], fixtureScreenOpened == false else { return }
        fixtureScreenOpened = true
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        if raw == "conversations" {
            selectedTab = .conversations
        } else if raw == "settings" {
            presentSettings(refresh: nil)
        } else if raw == "trio-settings" {
            debugScene = .trioSettings
        } else if raw.hasPrefix("conversation:") {
            let id = String(raw.dropFirst("conversation:".count))
            await routes.receive(.conversation(ConversationRoute(patientID: patient.patient_id, conversationID: id)))
        }
    }

    /// MELLIS_DEBUG_SEED_TRIO (simulator, Debug): what an owner would type in "Zdalne sterowanie Trio", without the
    /// file picker, for walkthroughs of "Przekaż moje ustawienia Trio".
    func seedRemoteSettingsIfRequested(patient: AccessiblePatient) async {
        #if targetEnvironment(simulator)
        guard isDeviceMode, let path = ProcessInfo.processInfo.environment["MELLIS_DEBUG_SEED_TRIO"], let apiClient,
              let data = FileManager.default.contents(atPath: path),
              let seed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let store = KeychainTrioRemoteSettingsStore()
        guard ((try? store.load(patientID: patient.patient_id)) ?? nil) == nil else { return }
        guard let target = try? await apiClient.getTrioRemoteTarget(patientID: patient.patient_id), let pinned = PinnedTrio(target: target.trio, at: Date()) else {
            DeviceModeDebugScene.log("seed-trio: Trio not ready in Nightscout")
            return
        }
        var settings = TrioRemoteSettings(
            sharedSecret: seed["shared_secret"] as? String ?? "",
            apnsKeyID: seed["apns_key_id"] as? String ?? "",
            apnsKeyP8: seed["apns_key_p8"] as? String ?? "",
            maxBolusUnits: Decimal(string: "\(seed["max_bolus_u"] ?? 5)") ?? 5,
            maxCarbsGrams: seed["max_carbs_g"] as? Int ?? 100,
            pinnedTrio: pinned
        )
        settings.limitsReviewed = true
        try? store.save(settings, patientID: patient.patient_id)
        NotificationCenter.default.post(name: .trioRemoteSettingsChanged, object: patient.patient_id)
        DeviceModeDebugScene.log("seed-trio: saved for \(patient.display_name), complete=\(settings.isComplete(glucoMindTeamID: GlucoMindPushIdentity.current().teamID))")
        #endif
    }

    /// Runs the requested scene once the patient's tabs show (device mode, Debug only).
    func runDebugSceneIfRequested(patient: AccessiblePatient) async {
        guard isDeviceMode, debugSceneStarted == false, let raw = DeviceModeDebugScene.requested else { return }
        debugSceneStarted = true
        if raw == "settings" {
            presentSettings(refresh: nil)
            return
        }
        if raw.hasPrefix("settings-") {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            settingsInitialRoute = settingsRoute(raw, patient: patient)
            presentSettings(refresh: nil)
            return
        }
        guard let scene = DeviceModeDebugScene.parse(raw) else { return }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        switch scene {
        case .grantSelf:
            // An owner grants remote bolus to themself; the grantee's confirmation follows on the screen (Face ID).
            guard let apiClient else { return }
            do {
                let people = try await apiClient.listPeople(patientID: patient.patient_id)
                if let me = people.you, me.remote_bolus.state == .off {
                    _ = try await apiClient.updatePerson(patientID: patient.patient_id, userID: me.user_id, changes: ["remote_commands": true])
                    DeviceModeDebugScene.log("granted remote bolus to self")
                }
            } catch {
                DeviceModeDebugScene.log("grant failed: \(error)")
            }
            debugScene = scene
        case let .sendBolus(carbsG, insulinU):
            await sendDebugBolus(patient: patient, carbsG: carbsG, insulinU: insulinU)
        default:
            debugScene = scene
        }
    }

    /// "settings-patient:Kuba" → the page of the patient named Kuba (the patient on screen without a name).
    private func settingsRoute(_ raw: String, patient: AccessiblePatient) -> SettingsRoute? {
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        let named = parts.count == 2 ? accessiblePatients.first { $0.display_name == parts[1] } : nil
        let patientID = (named ?? patient).patient_id
        switch parts[0] {
        case "settings-patient": return .patient(patientID)
        case "settings-remote-bolus": return .remoteBolus(patientID)
        case "settings-this-phone": return .thisPhone
        case "settings-lock-screen": return .lockScreen
        case "settings-about": return .about
        case "settings-privacy": return .privacy
        case "settings-add-patient": return .addPatient
        default: return nil
        }
    }

    /// The Bolus tab's command without the slider: preview (its warnings acknowledged), then the flow sends it, signed.
    private func sendDebugBolus(patient: AccessiblePatient, carbsG: Int, insulinU: Decimal) async {
        guard let apiClient else { return }
        for _ in 0..<20 where !canGiveRemotely {
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        guard canGiveRemotely, let flow = RemoteCommandCenter.shared.makeFlow(patientID: patient.patient_id, place: .bolusTab, patientName: patient.display_name) else {
            DeviceModeDebugScene.log("send-bolus: remote commands not available (capabilities: \(capabilities.remoteCommands))")
            return
        }
        selectedTab = .bolus
        do {
            let preview = try await apiClient.previewRemoteCommand(patientID: patient.patient_id, carbsG: carbsG, insulinU: insulinU, bolusStep: Decimal(string: "0.05")!, mealInMinutes: nil, proposalID: nil)
            DeviceModeDebugScene.log("preview blocks=\(preview.blocks.map(\.code)) warnings=\(preview.warnings.compactMap(\.key))")
            let draft = RemoteCommandDraft(source: .bolusScreen, carbsG: carbsG, insulinU: insulinU, acknowledgedWarnings: preview.warnings.compactMap(\.key), confirmedAt: Date())
            await flow.send(draft)
            DeviceModeDebugScene.log("send-bolus outcome: \(flow.state)")
        } catch {
            DeviceModeDebugScene.log("send-bolus preview failed: \(error)")
        }
    }
}

/// The scene's screen, presented over the tabs.
struct DeviceModeDebugSceneView: View {
    let scene: DeviceModeDebugScene
    let patient: AccessiblePatient
    let apiClient: APIClient
    @EnvironmentObject private var container: AppContainer

    var body: some View {
        NavigationStack {
            switch scene {
            case .sharing:
                DeviceSharingView(viewModel: sharingModel, onLeft: {})
            case .invite:
                InviteScene(viewModel: InvitePersonViewModel(api: apiClient, patientID: patient.patient_id, patientName: patient.display_name))
            case .grantSelf:
                SelfPersonScene(viewModel: sharingModel)
            case .thisPhone:
                ThisPhoneView(viewModel: ThisPhoneViewModel(api: apiClient))
            case .pairAnother:
                PairAnotherScene(viewModel: ThisPhoneViewModel(api: apiClient))
            case .addPatient:
                AddPatientView(viewModel: AddPatientViewModel(api: apiClient))
            case .join:
                JoinInvitationView(initialText: "")
            case .sendBolus:
                EmptyView()
            case .trioSettings:
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
            }
        }
    }

    private var sharingModel: DeviceSharingViewModel {
        DeviceSharingViewModel(patientID: patient.patient_id, patientName: patient.display_name, api: apiClient, signer: container.deviceSigner)
    }
}

/// "Ania" (MELLIS_UI_INVITE_NAME) with glucose, AI and remote bolus, created at once; the link goes to the scene log for
/// the second phone.
private struct InviteScene: View {
    @StateObject var viewModel: InvitePersonViewModel

    var body: some View {
        InvitePersonView(viewModel: viewModel)
            .task {
                guard viewModel.created == nil, !viewModel.isSending else { return }
                viewModel.firstName = ProcessInfo.processInfo.environment["MELLIS_UI_INVITE_NAME"] ?? DocsScreenshotNames.apply("Ania")
                viewModel.permissions = SharingPermissions(glucose_alerts: true, ai_chat_meals: true, manage_sharing: false, remote_commands: true)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await viewModel.send()
                if let link = viewModel.created?.pairing.pairing_url { DeviceModeDebugScene.log("invite \(link)") }
            }
    }
}

private struct SelfPersonScene: View {
    @StateObject var viewModel: DeviceSharingViewModel

    var body: some View {
        Group {
            if let me = viewModel.people?.you {
                PersonDetailView(viewModel: viewModel, person: me, onLeft: {})
            } else {
                BrandSpinner()
            }
        }
        .task {
            await viewModel.load()
            guard ProcessInfo.processInfo.environment["MELLIS_UI_CONFIRM"] == "1", viewModel.people?.you?.remote_bolus.state == .awaitingConfirmation else { return }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            let confirmed = await viewModel.confirmRemoteBolus()
            DeviceModeDebugScene.log("remote bolus confirm: \(confirmed) state=\(String(describing: viewModel.people?.you?.remote_bolus.state)) error=\(viewModel.errorMessage ?? "-")")
        }
    }
}

private struct PairAnotherScene: View {
    @StateObject var viewModel: ThisPhoneViewModel

    var body: some View {
        Group {
            if let code = viewModel.pairingCode {
                PairingCodeContent(
                    title: "Połącz kolejny telefon",
                    note: "Na nowym telefonie otwórz Mellis i stuknij Zeskanuj kod. Kod działa 10 minut i tylko raz. Nowy telefon będzie Twój, z tymi samymi uprawnieniami.",
                    code: code,
                    shareMessage: code.pairing_url
                )
            } else {
                BrandSpinner()
            }
        }
        .task {
            await viewModel.createPairingCode()
            if let link = viewModel.pairingCode?.pairing_url { DeviceModeDebugScene.log("pair-another \(link)") }
        }
    }
}
#endif
