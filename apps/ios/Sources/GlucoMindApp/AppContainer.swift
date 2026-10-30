import Foundation
import SwiftUI
import Combine
#if canImport(UIKit)
import UIKit
#endif
import GlucoMindCore

@MainActor
final class AppContainer: ObservableObject {
    @Published var bootstrapped = false
    @Published var bootstrapError: String?
    @Published var requiresSignIn = true
    @Published var signingIn = false
    @Published private(set) var patientEntryDestination: PatientLaunchDestination?
    @Published private(set) var patientEntryError: String?
    @Published private(set) var loadingPatientEntry = false
    /// Set when this build is older than the server's minimum (GET /v1/app-config): shown as a banner on every screen.
    @Published private(set) var updateRequiredMessage: String?
    @Published private(set) var accessiblePatients: [AccessiblePatient] = []
    /// The signed-in caregiver's name, for the greeting of an empty new conversation.
    @Published private(set) var userDisplayName: String?
    /// The signed-in person's id (GET /v1/me/patients): with the server it marks the setup guide as seen.
    @Published private(set) var userID: String?
    /// "Przewodnik konfiguracji" on screen (SetupGuideView), once per person on this phone or from Settings.
    @Published var setupGuide: SetupGuideRequest?
    /// Grows with each "Przewodnik po ekranie Bolus" from Settings: the Bolus tab opens its tour.
    @Published private(set) var bolusTourRequest = 0
    /// The spotlight tour on screen and the frames of the elements it points at, drawn at the root over the bars.
    let tourController = SpotlightTourController()
    let tourFrames = TourAnchorFrames()
    /// The guide was considered in this run of the app (it is offered at most once per launch and sign-in).
    private var setupGuideConsidered = false
    /// An account sign-in just succeeded: the person's id is not known yet, so the guide's "pending" mark is set as
    /// soon as GET /v1/me/patients names them (before the tabs show).
    private var setupGuidePendingForNextUser = false
    @Published private(set) var selectedConversationID: String?
    @Published private(set) var selectedConversationPatientID: String?
    @Published private(set) var selectedConversationRefreshNonce: Int = 0
    /// Live updates of the patient on screen (live-updates.v1); paused in the background.
    @Published private(set) var liveUpdates: LiveUpdates?
    private var eventStreamTransport: EventStreamTransport = URLSessionEventStreamTransport()
    private var isInForeground = true

    /// Whether this caregiver may send remote commands for the patient on screen (off until the server says so).
    let capabilities = PatientCapabilitiesStore()
    @Published var selectedTab: AppTab = .dashboard
    /// Meal to open in the meals tab (set by a meal notification).
    @Published var mealsFocus: MealRoute?
    /// The conversation a notification opened last (shown even when the history does not list it).
    @Published private(set) var conversationOpenedFromNotification: String?
    /// Grows when a notification opens a screen: the sheets on screen close (`closesForNotification`).
    @Published private(set) var notificationDismissal = 0
    let modalTracker = NotificationModalTracker()
    /// The settings screen behind the gear (open across returns from the background).
    @Published var isSettingsPresented = false
    /// "Odśwież" in the settings: the screen that opened them (nil: none).
    private(set) var settingsRefresh: (() -> Void)?
    /// A settings page to open with the sheet (Debug scenes); cleared when it closes.
    var settingsInitialRoute: SettingsRoute?
    /// Set by "Zapytaj w czacie" (Bolus tab, a meal's page): the conversations tab opens a new, empty conversation.
    @Published private(set) var newChatRequest: UUID?
    /// Set by the home-screen widget's equipment field: the dashboard opens its equipment list.
    @Published private(set) var equipmentRequest: UUID?

    private(set) var apiClient: APIClient?
    /// The bell's notification list per patient, shared by the top bars of every tab (one read, one live subscription).
    private var notificationHistories: [String: NotificationHistoryViewModel] = [:]
    private var authProvider: SessionAuthProvider?
    private var patientAccessResolver: PatientAccessResolver?
    private var pushManager: PushNotificationManager?
    private var runtimeAuthMode: RuntimeAuthMode = .cognito
    /// Device mode: this phone's pairing, keys and sessions (nil in the other modes).
    private(set) var deviceAuth: DeviceAuthProvider?
    private var deviceKeys: DeviceKeyStore?
    private var devicePairingStore: DevicePairingStore?
    private(set) var deviceSigner: DeviceRemoteCommandSigner?
    /// Device mode: remote control settings an owner handed to this phone (docs/device-auth-api.md §8).
    private(set) var handoffInbox: RemoteSettingsInboxModel?
    /// A waiting package offered over the app once per launch (app start, return to the app, after confirming remote bolus).
    @Published var handoffOffer: RemoteSettingsHandoff?
    private var handoffOffersShown: Set<String> = []
    private var remoteBolusConfirmations: AnyCancellable?
    /// A new package announced by a push received while the app is open (1.0.5): the packages are read at once.
    private var handoffPushes: AnyCancellable?
    /// The live stream's "remote_settings_handoff" changes of the patient on screen (1.0.5).
    private var handoffLiveChanges: AnyCancellable?
    /// "Jeszcze jeden krok" (1.0.5): Trio / Loop settings are ready here but remote bolus is not, once per settings save.
    @Published var remoteBolusNextStep: RemoteBolusNextStepRequest?
    let remoteBolusNextStepPrompts: RemoteBolusNextStepPromptStore = UserDefaultsRemoteBolusNextStepPromptStore()
    private var nextStepCheck: Task<Void, Never>?
    /// Device mode: the server and device this phone is paired with (nil: the pairing screen).
    @Published private(set) var pairing: DevicePairing?
    /// A `mellis://pair` link that opened the app (or MELLIS_PAIRING_URL at first launch): the pairing screen asks to
    /// connect, a paired phone offers "Dołącz".
    @Published var incomingPairingLink: PairingLink?
    @Published var incomingPairingError: String?
    /// This phone's DIY acknowledgement (DIYAcknowledgement): pairing cannot complete before it is accepted.
    let diyAcknowledgement: DIYAcknowledgementStoring = UserDefaultsDIYAcknowledgementStore()
    @Published private(set) var pairingAcknowledged = false
    /// The recovery code a recovery answered with: shown once over the patient's screens.
    @Published var newRecoveryCode: String?
    /// "Dołącz" asked for without a link (a paired phone with no patient left).
    @Published var isJoinPresented = false
    #if DEBUG
    /// MELLIS_UI_SCENE (DeviceModeDebugScenes.swift): the screen a simulator walkthrough shows.
    @Published var debugScene: DeviceModeDebugScene?
    var debugSceneStarted = false
    var fixtureScreenOpened = false
    #endif

    /// Signing out only exists with Cognito; in the local no-auth mode the action would do nothing. A paired phone is
    /// disconnected in Udostępnianie → Ten telefon instead.
    var canSignOut: Bool {
        runtimeAuthMode == .cognito
    }

    /// "Odłącz ten telefon" on the "Brak listy pacjentów" screen (1.0.5): a paired phone whose server is gone is not
    /// stuck there. Device mode, or the UI fixtures of that screen (GLUCOMIND_UI_FIXTURES_PATIENTS_ERROR, Debug only).
    var canUnpairFromErrorScreen: Bool {
        #if DEBUG
        if runtimeValue(UIPreviewFixtureHTTPClient.environmentKey) == "1", ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_PATIENTS_ERROR"] != nil { return true }
        #endif
        return isDeviceMode
    }

    /// Self-hosted Mellis: pairing instead of accounts (Udostępnianie, Dodaj pacjenta, Ten telefon).
    var isDeviceMode: Bool {
        runtimeAuthMode == .device
    }

    /// Zdalny bolus shows this person's grant ("Ty i ten telefon"): device mode, or the UI fixtures of it
    /// (GLUCOMIND_UI_FIXTURES_SELF_GRANT, Debug only).
    var showsRemoteBolusGrant: Bool {
        #if DEBUG
        if runtimeValue(UIPreviewFixtureHTTPClient.environmentKey) == "1", UIPreviewFixtureHTTPClient.selfGrantRole != nil { return true }
        #endif
        return isDeviceMode
    }

    /// Debug builds accept a local http:// server in pairing links.
    static var allowsInsecureServer: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    /// The patient whose tabs are on screen.
    var currentPatient: AccessiblePatient? {
        if case .dashboard(let patient) = patientEntryDestination {
            return patient
        }
        return nil
    }
    /// This phone has the current patient's remote control fully set up (every settings step done): until then no way
    /// to give a bolus is shown (no Bolus tab, no button on cards, the WBT window or meals).
    @Published private(set) var remoteSetupComplete = false
    /// The patient `remoteSetupComplete` was last read for.
    private var remoteSetupPatientID: String?
    private var remoteSetupChanges: AnyCancellable?
    private var protectedDataChanges: AnyCancellable?
    /// A Bolus tab asked for before the patient's capabilities were read (the widget's Bolus on a cold start): opened
    /// once they allow it, within a few seconds.
    private var pendingBolusTab: (patientID: String, until: Date)?

    /// The server allows remote commands for this caregiver and patient, and this phone is set up for them. The
    /// capabilities must be the current patient's: an answer about the previous patient never enables the next one.
    var canGiveRemotely: Bool {
        guard let patient = currentPatient, capabilities.patientID?.lowercased() == patient.patient_id.lowercased() else { return false }
        return capabilities.remoteCommands.enabled && remoteSetupComplete
    }

    func refreshRemoteSetup() {
        guard let patient = currentPatient else {
            remoteSetupPatientID = nil
            remoteSetupComplete = false
            return
        }
        var complete: Bool
        do {
            // The settings of the loop the patient runs: Loop's QR code and keys, or Trio's.
            let team = GlucoMindPushIdentity.current().teamID
            if sendsToLoop(patientID: patient.patient_id) {
                complete = try KeychainLoopRemoteSettingsStore().load(patientID: patient.patient_id)?.isComplete(glucoMindTeamID: team) ?? false
            } else {
                complete = try KeychainTrioRemoteSettingsStore().load(patientID: patient.patient_id)?.isComplete(glucoMindTeamID: team) ?? false
            }
            remoteSetupPatientID = patient.patient_id
        } catch {
            // The settings are readable only while the phone is unlocked: a read while it is locked (or another Keychain
            // error) keeps this patient's last answer, and unlocking or returning to the app reads again.
            NSLog("[REMOTE-SETUP] keychain read failed patientId=%@ error=%@", patient.patient_id, String(describing: error))
            complete = remoteSetupPatientID == patient.patient_id && remoteSetupComplete
        }
        #if DEBUG
        // A local server check without any loop (GLUCOMIND_REMOTE_DRY_RUN=1): set up, commands stop at the server.
        if RemoteCommandCenter.isDryRun { complete = true }
        // Visual checks of the Bolus tab: fixtures with GLUCOMIND_UI_FIXTURES_REMOTE=1 count as set up (nothing can be sent).
        if runtimeValue(UIPreviewFixtureHTTPClient.environmentKey) == "1", ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_REMOTE"] == "1" {
            complete = true
            // GLUCOMIND_UI_FIXTURES_BOLUS=<grams> opens the Bolus tab with them typed (RemoteBolusTabView).
            // GLUCOMIND_UI_FIXTURES_BOLUS_TOUR=<step> opens it with the tour at that step.
            if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_BOLUS"] != nil || ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_BOLUS_TOUR"] != nil, !remoteSetupComplete { selectedTab = .bolus }
        }
        // GLUCOMIND_UI_FIXTURES_MEALS=1 (or a meal id, opened by the tab) opens the Meals tab.
        if runtimeValue(UIPreviewFixtureHTTPClient.environmentKey) == "1", ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_MEALS"] != nil, selectedTab != .meals {
            selectedTab = .meals
        }
        // GLUCOMIND_UI_FIXTURES_SEARCH=1 (or =<text>, typed in) opens the Meals tab with its search.
        if runtimeValue(UIPreviewFixtureHTTPClient.environmentKey) == "1", ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SEARCH"] != nil, selectedTab != .meals {
            selectedTab = .meals
        }
        #endif
        if complete != remoteSetupComplete { remoteSetupComplete = complete }
    }

    private var capabilitiesChanges: AnyCancellable?

    /// The route of the last tapped notification until it can be shown (signed in, patient list loaded).
    private(set) lazy var routes = PendingRouteCoordinator(
        isSignedIn: { [weak self] in await self?.ensureAuthenticatedSession() ?? false },
        knownPatientIDs: { [weak self] in self?.knownPatientIDsForRoutes },
        refreshPatientIDs: { [weak self] in try await self?.refreshAccessiblePatients() ?? [] },
        deliver: { [weak self] route in self?.open(route) }
    )
    /// Until the first patient list after launch or sign-in is read, a route waits for it instead of asking the server.
    private var awaitingPatientList = true
    private var routeTask: Task<Void, Never>?

    init() {
        #if DEBUG
        // UI fixtures and simulator walkthroughs (MELLIS_AUTO_PAIR, MELLIS_UI_SCENE) start accepted: nothing to tap.
        if ProcessInfo.processInfo.environment[UIPreviewFixtureHTTPClient.environmentKey] == "1" || DeviceModeDebugScene.autoPair || DeviceModeDebugScene.requested != nil {
            for scope in DIYAcknowledgement.Scope.allCases { diyAcknowledgement.acceptIfNeeded(scope) }
        }
        #endif
        pairingAcknowledged = diyAcknowledgement.isAccepted(.pairing)
        capabilitiesChanges = capabilities.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
        remoteSetupChanges = NotificationCenter.default.publisher(for: .trioRemoteSettingsChanged)
            .receive(on: RunLoop.main)
            .sink { [weak self] note in
                self?.refreshRemoteSetup()
                // Settings saved (a hand-off's "Zapisz", typed in): maybe one more step before bolusing (1.0.5).
                if let patientID = note.object as? String { self?.considerRemoteBolusNextStep(patientID: patientID) }
            }
        handoffPushes = NotificationCenter.default.publisher(for: .remoteSettingsHandoffPushReceived)
            .receive(on: RunLoop.main)
            .sink { [weak self] note in
                self?.handoffAnnounced(handoffID: note.object as? String)
            }
        remoteBolusConfirmations = NotificationCenter.default.publisher(for: .remoteBolusConfirmedOnThisPhone)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in Task { await self?.refreshHandoffs() } }
        #if canImport(UIKit)
        protectedDataChanges = NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshRemoteSetup() }
        #endif
    }

    private func isPlaceholder(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasPrefix("<") && trimmed.hasSuffix(">")
    }

    private func runtimeValue(_ key: String) -> String? {
        if let envValue = ProcessInfo.processInfo.environment[key], !envValue.isEmpty, !isPlaceholder(envValue) {
            return envValue
        }

        if let infoValue = Bundle.main.object(forInfoDictionaryKey: key) as? String,
           !infoValue.isEmpty,
           !infoValue.hasPrefix("$("),
           !isPlaceholder(infoValue) {
            return infoValue
        }

        return nil
    }

    func bootstrap() async {
        guard !bootstrapped else {
            return
        }

        let baseURLString = runtimeValue("API_BASE_URL") ?? runtimeValue("GLUCOMIND_API_BASE_URL")
        let authModeValue = runtimeValue("AUTH_MODE")
        let allowDisabledAuthInLocalValue = runtimeValue("ALLOW_AUTH_DISABLED_IN_LOCAL")
        let cognitoDomain = runtimeValue("COGNITO_DOMAIN_URL")
        let cognitoClientID = runtimeValue("COGNITO_CLIENT_ID")
        let cognitoRedirectURI = runtimeValue("COGNITO_REDIRECT_URI")
        let cognitoScopes = runtimeValue("COGNITO_SCOPES") ?? "openid profile email"

        let isDebugBuild: Bool = {
#if DEBUG
            true
#else
            false
#endif
        }()

        do {
            runtimeAuthMode = try RuntimeAuthModeResolver.resolve(
                authModeValue: authModeValue,
                allowDisabledValue: allowDisabledAuthInLocalValue,
                isDebugBuild: isDebugBuild,
                // Empty COGNITO_* (a community build's Config.xcconfig): device auth.
                cognitoConfigured: cognitoDomain != nil && cognitoClientID != nil
            )
        } catch RuntimeAuthModeResolutionError.invalidAuthMode {
            bootstrapError = "Błędna konfiguracja: AUTH_MODE musi mieć wartość device, cognito albo disabled."
            bootstrapped = true
            return
        } catch RuntimeAuthModeResolutionError.invalidAllowDisabledFlag {
            bootstrapError = "Błędna konfiguracja: ALLOW_AUTH_DISABLED_IN_LOCAL musi mieć wartość true/false albo 1/0."
            bootstrapped = true
            return
        } catch RuntimeAuthModeResolutionError.disabledModeNotAllowed {
            bootstrapError = "Błędna konfiguracja: AUTH_MODE=disabled jest dozwolone tylko w lokalnej wersji debug z ALLOW_AUTH_DISABLED_IN_LOCAL=true."
            bootstrapped = true
            return
        } catch RuntimeAuthModeResolutionError.localTokenNotAllowed {
            bootstrapError = "Błędna konfiguracja: AUTH_MODE=local_token jest dozwolone tylko w lokalnej wersji debug."
            bootstrapped = true
            return
        } catch {
            bootstrapError = "Błędna konfiguracja logowania."
            bootstrapped = true
            return
        }

        if runtimeAuthMode == .device {
            await bootstrapDeviceMode()
            return
        }

        guard let baseURLString,
              let baseURL = URL(string: baseURLString) else {
            bootstrapError = "Błędna konfiguracja: ustaw API_BASE_URL albo GLUCOMIND_API_BASE_URL."
            bootstrapped = true
            return
        }

        let client: APIClient
        switch runtimeAuthMode {
        case .disabledLocal:
            authProvider = nil
            #if DEBUG
            // Visual checks only: fixtures answer every request (and stream live events), nothing is sent over the network.
            let fixtures = runtimeValue(UIPreviewFixtureHTTPClient.environmentKey) == "1" ? UIPreviewFixtureHTTPClient() : nil
            let httpClient: HTTPClient = fixtures ?? URLSessionHTTPClient()
            if let fixtures {
                eventStreamTransport = fixtures
                UIPreviewFixtureSender.isActive = true
            }
            #else
            let httpClient: HTTPClient = URLSessionHTTPClient()
            #endif
            client = APIClient(baseURL: baseURL, authorizationMode: .none, httpClient: httpClient)
            requiresSignIn = false
        case .localToken:
            authProvider = nil
            #if DEBUG
            // Development secret compiled into Debug builds only (LOCAL_AUTH_TOKEN_EMBEDDED); not protection against
            // anyone holding the app bundle, and never for distribution.
            guard let localToken = try? RuntimeAuthModeResolver.resolveLocalToken(runtimeValue("LOCAL_AUTH_TOKEN")) else {
                bootstrapError = "Błędna konfiguracja: AUTH_MODE=local_token wymaga LOCAL_AUTH_TOKEN w lokalnej konfiguracji debug."
                bootstrapped = true
                return
            }
            client = APIClient(baseURL: baseURL, authProvider: DevelopmentTokenAuthProvider(token: localToken), httpClient: URLSessionHTTPClient())
            requiresSignIn = false
            #else
            bootstrapError = "Błędna konfiguracja: AUTH_MODE=local_token jest dozwolone tylko w lokalnej wersji debug."
            bootstrapped = true
            return
            #endif
        case .cognito, .device:
            guard let cognitoDomain,
                  let cognitoDomainURL = URL(string: cognitoDomain),
                  let cognitoClientID,
                  let cognitoRedirectURI,
                  let cognitoRedirectURL = URL(string: cognitoRedirectURI) else {
                bootstrapError = "Błędna konfiguracja: ustaw COGNITO_DOMAIN_URL, COGNITO_CLIENT_ID i COGNITO_REDIRECT_URI."
                bootstrapped = true
                return
            }

            let oauthConfig = CognitoOAuthConfiguration(
                domainURL: cognitoDomainURL,
                clientID: cognitoClientID,
                redirectURI: cognitoRedirectURL,
                scopes: cognitoScopes
                    .split(separator: " ")
                    .map(String.init)
                    .filter { !$0.isEmpty }
            )
            // In the group the home-screen widget reads too (GMKeychainAccessGroup, the app's keychain-access-groups).
            let tokenStore = KeychainOAuthTokenStore.session(accessGroup: runtimeValue("GMKeychainAccessGroup"))
            let oauthClient = CognitoOAuthClient(
                config: oauthConfig,
                authorizationFlow: SystemBrowserAuthorizationCodeFlow(),
                httpClient: URLSessionHTTPClient()
            )
            let auth = CognitoAuthProvider(oauthClient: oauthClient, tokenStore: tokenStore)
            // The refresh token was rejected while the app is open: the sign-in screen replaces the tabs at once.
            await auth.setSessionEndedHandler { [weak self] in
                Task { @MainActor in self?.sessionEnded() }
            }
            authProvider = auth
            client = APIClient(baseURL: baseURL, authProvider: auth, httpClient: URLSessionHTTPClient())
        }

        await configureServices(client: client)
        switch runtimeAuthMode {
        case .disabledLocal, .localToken:
            requiresSignIn = false
        case .cognito, .device:
            if let auth = authProvider {
                requiresSignIn = !(await auth.restoreSession())
            }
        }

        if !requiresSignIn {
            await loadPatientEntryDestination()
        }

        bootstrapped = true
        await refreshAppConfig()
    }

    /// Device mode: no server in the build. A paired phone opens on its server; an unpaired one shows the pairing screen
    /// (with the link the installer passed at first launch, if any).
    private func bootstrapDeviceMode() async {
        let accessGroup = runtimeValue("GMKeychainAccessGroup")
        let keys = DeviceKeyStores.standard(accessGroup: accessGroup)
        let store = KeychainDevicePairingStore(accessGroup: accessGroup)
        let auth = DeviceAuthProvider(store: store, keys: keys, transport: HTTPDeviceAuthTransport())
        // The server revoked this phone (or forgot it): the pairing screen replaces the tabs at once.
        await auth.setSessionEndedHandler { [weak self] in
            Task { @MainActor in self?.sessionEnded() }
        }
        deviceAuth = auth
        deviceKeys = keys
        devicePairingStore = store
        authProvider = auth
        pairing = await auth.pairing()
        if let pairing {
            await configureDeviceServices(server: pairing.serverURL, awaitingNotifications: false)
            requiresSignIn = !(await auth.restoreSession())
        } else {
            requiresSignIn = true
        }
        if requiresSignIn, incomingPairingLink == nil, let launchLink = runtimeValue("MELLIS_PAIRING_URL") {
            receivePairingLink(text: launchLink)
        }
        if !requiresSignIn {
            await loadPatientEntryDestination()
        }
        bootstrapped = true
        await refreshAppConfig()
    }

    /// The API of the paired server: every request carries the device session and renews it on a 401.
    private func configureDeviceServices(server: URL, awaitingNotifications: Bool = true) async {
        guard let auth = deviceAuth else { return }
        // Paired with another server than the one the remote-control settings were made with: they all go.
        if RemoteSettingsCleanup.serverChanged(to: server, trioStore: KeychainTrioRemoteSettingsStore(), loopStore: KeychainLoopRemoteSettingsStore()) {
            NSLog("[REMOTE-SETTINGS] another server: all remote settings removed")
        }
        if apiClient?.baseURL == server { return }
        let client = APIClient(baseURL: server, authProvider: auth, httpClient: DeviceSessionHTTPClient(base: URLSessionHTTPClient(), provider: auth))
        if let keys = deviceKeys, let store = devicePairingStore {
            // Read where the signer runs (off the main actor): the pairing in the Keychain is the current one.
            deviceSigner = DeviceRemoteCommandSigner(api: client, deviceID: { (try? store.loadPairing())?.deviceID }, keys: keys)
            handoffInbox = RemoteSettingsInboxModel(api: client, keys: keys, deviceID: { (try? store.loadPairing())?.deviceID },
                                                    trioStore: KeychainTrioRemoteSettingsStore(), loopStore: KeychainLoopRemoteSettingsStore())
        }
        await configureServices(client: client, awaitingNotifications: awaitingNotifications)
    }

    /// The services every mode builds around its API client (remote commands, Live Activity, notifications).
    /// `awaitingNotifications` false: the notification permission question does not hold the caller (a phone that has
    /// just paired opens its patients at once; the question shows over them).
    private func configureServices(client: APIClient, awaitingNotifications: Bool = true) async {
        apiClient = client
        RemoteCommandCenter.shared.configure(apiClient: client, pushToken: { [weak self] in self?.pushManager?.currentToken }, signer: deviceSigner)
        RemoteCommandCenter.shared.sendsToLoop = { [weak self] patientID in self?.sendsToLoop(patientID: patientID) ?? false }
        LiveActivityController.shared.configure(apiClient: client)

        let resolver = PatientAccessResolver(api: client)
        patientAccessResolver = resolver

        let deviceID = DeviceIDStore.shared.deviceID
        let appVersion = AppBuildInfo.current.displayText
        let registrar = APIBasedDeviceRegistrationService(apiClient: client)
        pushManager = PushNotificationManager(
            deviceID: deviceID,
            appVersion: appVersion,
            registrar: registrar,
            patientIDsProvider: { [weak self] in
                guard let resolver = self?.patientAccessResolver else {
                    return []
                }

                let ids = try await resolver.refreshAccessiblePatientIDs()
                return Array(ids)
            }
        )

        NSLog("[PUSH-TAP] 06 inbox.bind")
        RemoteNotificationInbox.shared.bind(
            onPushPayload: { [weak self] userInfo in
                let conversationID = Self.safeConversationID(from: userInfo)
                NSLog("[PUSH-TAP] 08 navigator.handle start conversationId=%@", conversationID)
                Task { @MainActor in
                    await self?.handlePushPayload(userInfo)
                }
                NSLog("[PUSH-TAP] 09 navigator.handle end conversationId=%@", conversationID)
            },
            onDeviceToken: { [weak self] tokenData in
                Task {
                    await self?.pushManager?.registerReceivedDeviceToken(tokenData)
                }
            }
        )

        #if DEBUG
        // Simulator walkthroughs: no permission question over the screens (DeviceModeDebugScenes.swift).
        if ProcessInfo.processInfo.environment["MELLIS_SKIP_NOTIFICATION_PROMPT"] == "1" { return }
        #endif
        if awaitingNotifications {
            await pushManager?.configureNotifications()
        } else {
            Task { await pushManager?.configureNotifications() }
        }
    }

    // MARK: - Device mode: pairing

    /// A pairing link from the camera, a paste or a deep link. Unpaired: the pairing screen asks to connect. Paired: an
    /// invitation of the same server is offered as "Dołącz"; another server's link cannot be used on this phone.
    func receivePairingLink(text: String) {
        switch PairingLink.parse(text, allowsInsecureHTTP: Self.allowsInsecureServer) {
        case let .success(link):
            receive(link)
        case let .failure(error):
            incomingPairingError = error.message
        }
    }

    private func receive(_ link: PairingLink) {
        incomingPairingError = nil
        if let pairing, !requiresSignIn, !link.isSameServer(as: pairing.serverURL) {
            incomingPairingError = "Ten link jest z innego serwera Mellis (\(link.serverURL.host ?? link.serverURL.absoluteString)). Ten telefon jest połączony z \(pairing.serverURL.host ?? pairing.serverURL.absoluteString)."
            return
        }
        incomingPairingLink = link
    }

    /// "Rozumiem i akceptuję" on the pairing screen: remembered on this phone.
    func acceptPairingAcknowledgement() {
        diyAcknowledgement.acceptIfNeeded(.pairing)
        pairingAcknowledged = true
    }

    /// Pairs this phone with the link's server and opens its patients (only after the DIY acknowledgement).
    func pair(with link: PairingLink) async throws {
        guard let deviceAuth else { return }
        guard diyAcknowledgement.isAccepted(.pairing) else { throw DIYAcknowledgementError.notAccepted }
        let response = try await deviceAuth.pair(link: link, deviceName: Self.deviceName, clientDeviceID: DeviceIDStore.shared.deviceID)
        await didPair(server: link.serverURL, response: response)
    }

    /// "Mam kod odzyskiwania": pairs into the first owner; the new recovery code is shown once (`newRecoveryCode`).
    func recover(server: URL, recoveryCode: String) async throws {
        guard let deviceAuth else { return }
        guard diyAcknowledgement.isAccepted(.pairing) else { throw DIYAcknowledgementError.notAccepted }
        let response = try await deviceAuth.recover(server: server, recoveryCode: recoveryCode, deviceName: Self.deviceName, clientDeviceID: DeviceIDStore.shared.deviceID)
        newRecoveryCode = response.recovery_code
        await didPair(server: server, response: response)
    }

    private func didPair(server: URL, response: PairResponse) async {
        incomingPairingLink = nil
        incomingPairingError = nil
        pairing = await deviceAuth?.pairing()
        await configureDeviceServices(server: server, awaitingNotifications: false)
        // A new pairing of this phone: the setup guide once, at the dashboard (an update with a session never gets here).
        SetupGuideViewModel.noteNewPairing(store: UserDefaultsSetupGuideSeenStore(), key: SetupGuideKey.make(server: apiClient?.baseURL ?? server, userID: response.user.user_id))
        requiresSignIn = false
        bootstrapError = nil
        HomeWidgetReloader.reload()
        await loadPatientEntryDestination()
        await refreshAppConfig()
    }

    /// "Dołącz": an invitation code entered (or opened) on an already paired phone. Returns the patient's name.
    func acceptInvitation(code: String) async throws -> String {
        guard let apiClient else { throw APIClientError.transport("not configured") }
        let accepted = try await apiClient.acceptInvitation(code: code)
        incomingPairingLink = nil
        _ = try? await refreshAccessiblePatients()
        if let patient = accessiblePatients.first(where: { $0.patient_id.lowercased() == accepted.patient_id.lowercased() }) {
            selectPatient(patient)
            return patient.display_name
        }
        return accepted.patient_id
    }

    /// "Dodaj pacjenta" saved a patient: the list is read again and the new patient opens.
    func patientAdded(_ patientID: String) async {
        _ = try? await refreshAccessiblePatients()
        if let patient = accessiblePatients.first(where: { $0.patient_id.lowercased() == patientID.lowercased() }) {
            selectPatient(patient)
        }
    }

    /// "Odłącz" on this phone: the server forgets it (best effort), then the pairing and keys go and the pairing screen
    /// shows. Another phone of the person keeps working.
    func unpairThisPhone() async {
        guard let deviceAuth else { return }
        if let apiClient, let deviceID = pairing?.deviceID {
            // A server that no longer answers must not hold the phone ("Brak listy pacjentów" → "Odłącz ten telefon"):
            // at most a few seconds, then the pairing is forgotten here anyway.
            let revoked = await Self.withTimeout(seconds: 6) {
                try await apiClient.revokeOwnDevice(deviceID: deviceID)
            }
            if !revoked {
                NSLog("[DEVICE-AUTH] revoke on unpair failed or timed out: forgotten on this phone only")
            }
        }
        await deviceAuth.signOut()
        pairing = nil
        // Nothing of this phone's remote control outlives the pairing (secrets, keys, the confirmed Trio / Loop).
        RemoteSettingsCleanup.removeAll(trioStore: KeychainTrioRemoteSettingsStore(), loopStore: KeychainLoopRemoteSettingsStore())
        RemoteSettingsCleanup.forgetServer()
        HomeWidgetReloader.reload()
        await LiveActivityController.shared.signedOut()
        resetSignedInState(keepingPendingRoute: false)
    }

    /// Runs `work` for at most `seconds`; true when it finished without an error.
    static func withTimeout(seconds: Double, _ work: @escaping @Sendable () async throws -> Void) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                do { try await work(); return true } catch { return false }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }

    /// "Połącz ponownie" (a new bolus key after a Face ID change): a code for this person, new keys, a new pairing of
    /// this phone, then the old device is revoked.
    func repairThisPhone() async throws {
        guard let deviceAuth, let apiClient, let old = pairing else { return }
        let code = try await apiClient.createOwnPairingCode()
        guard case let .success(link) = PairingLink.parse(code.pairing_url, allowsInsecureHTTP: Self.allowsInsecureServer) else {
            throw APIClientError.invalidResponse
        }
        // The code is used on the server this phone knows (PUBLIC_BASE_URL may name another address of it).
        _ = try await deviceAuth.pair(link: PairingLink(serverURL: old.serverURL, code: link.code), deviceName: Self.deviceName, clientDeviceID: DeviceIDStore.shared.deviceID)
        pairing = await deviceAuth.pairing()
        // The new session revokes the old device row (same person).
        try? await apiClient.revokeOwnDevice(deviceID: old.deviceID)
        HomeWidgetReloader.reload()
    }

    /// Device mode: this phone holds its own bolus key (it may still need registering with the server).
    var thisPhoneHasLocalBolusKey: Bool {
        ((try? deviceKeys?.loadKeys()) ?? nil)?.bolus != nil
    }

    static var deviceName: String {
        #if canImport(UIKit)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? "Mac"
        #endif
    }

    func signIn() async {
        // Device mode pairs on the pairing screen instead.
        if runtimeAuthMode == .device { return }
        guard runtimeAuthMode == .cognito else {
            requiresSignIn = false
            return
        }

        guard let authProvider else {
            return
        }

        signingIn = true
        defer {
            signingIn = false
        }

        do {
            try await authProvider.signIn()
            // A sign-in on this phone (not a restored session): the setup guide once, for whoever it names.
            setupGuidePendingForNextUser = true
            requiresSignIn = false
            HomeWidgetReloader.reload()
            bootstrapError = nil
            await loadPatientEntryDestination()
        } catch {
            bootstrapError = "Nie udało się zalogować. Spróbuj ponownie."
            requiresSignIn = true
        }
    }

    func signOut() async {
        // A paired phone has no sign-out: "Odłącz ten telefon" forgets the pairing.
        if runtimeAuthMode == .device {
            await unpairThisPhone()
            return
        }
        guard runtimeAuthMode == .cognito else {
            return
        }

        guard let authProvider else {
            return
        }

        // While the token is still valid: this phone stops getting the caregiver's notifications. A failure (offline)
        // does not stop the sign-out.
        if let apiClient, let pushToken = pushManager?.currentToken {
            do {
                try await apiClient.signOutDevice(pushToken: pushToken)
                PendingDeviceRelease.clear()
            } catch {
                // Released later without a session (audit 2026-10-26): else the phone keeps getting this caregiver's
                // notifications until someone signs in.
                PendingDeviceRelease.save(pushToken: pushToken)
                NSLog("[APNS] device sign-out failed error=%@", String(describing: error))
            }
        }
        await authProvider.signOut()
        HomeWidgetReloader.reload()
        await LiveActivityController.shared.signedOut()
        // Signed out on purpose: a notification tapped before does not open for whoever signs in next.
        resetSignedInState(keepingPendingRoute: false)
    }

    /// A sign-out this phone could not send: released now, while nobody is signed in (launch, foreground).
    func releasePendingDeviceIfSignedOut() async {
        guard runtimeAuthMode != .device, requiresSignIn, let apiClient, let pushToken = PendingDeviceRelease.pushToken() else {
            return
        }
        do {
            try await apiClient.releaseDevice(pushToken: pushToken, releaseSecret: DeviceReleaseSecret.current())
            PendingDeviceRelease.clear()
        } catch {
            NSLog("[APNS] pending device release failed error=%@", String(describing: error))
        }
    }

    /// The session ended without signing out (refresh token rejected, also while the app is open): the sign-in screen
    /// replaces the tabs and the live stream stops retrying. A tapped notification still opens after signing in again.
    func sessionEnded() {
        guard runtimeAuthMode == .cognito || runtimeAuthMode == .device, !requiresSignIn else {
            return
        }
        if runtimeAuthMode == .device {
            // The server no longer knows this phone (revoked, "Odłącz"): back to the pairing screen.
            pairing = nil
            Task { await LiveActivityController.shared.signedOut() }
        }
        resetSignedInState(keepingPendingRoute: true)
        HomeWidgetReloader.reload()
    }

    /// The patient's notification list behind the bell (created on first use, kept while signed in). Not published:
    /// reading it from a view's body changes nothing on screen.
    func notificationHistory(apiClient: APIClient, patientID: String) -> NotificationHistoryViewModel {
        if let existing = notificationHistories[patientID] {
            return existing
        }
        let created = NotificationHistoryViewModel(apiClient: apiClient, patientID: patientID)
        notificationHistories[patientID] = created
        return created
    }

    /// Nothing of the signed-in caregiver stays on screen or running.
    private func resetSignedInState(keepingPendingRoute: Bool) {
        notificationHistories = [:]
        stopLiveUpdates()
        isSettingsPresented = false
        RemoteCommandCenter.shared.cancelConfirmations(exceptPatientID: nil)
        if !keepingPendingRoute {
            routes.clear()
        }
        routeTask?.cancel()
        awaitingPatientList = true
        mealsFocus = nil
        conversationOpenedFromNotification = nil
        requiresSignIn = true
        patientEntryDestination = nil
        patientEntryError = nil
        accessiblePatients = []
        userDisplayName = nil
        userID = nil
        setupGuide = nil
        remoteBolusNextStep = nil
        nextStepCheck?.cancel()
        setupGuideConsidered = false
        setupGuidePendingForNextUser = false
        selectedConversationID = nil
        selectedConversationPatientID = nil
        selectedConversationRefreshNonce = 0
        // The next session's patients are not known yet: the remote-control guards count every patient on this phone.
        RemotePatientScope.shared.reset()
    }

    /// A successfully read, non-empty patient list: the remote-control guards compare only with these patients, and
    /// Trio / Loop settings this phone keeps for any other patient id (a reinstalled or restored server, another
    /// pairing) are removed. An error or an empty list changes nothing.
    private func noteVisiblePatients(_ patients: [AccessiblePatient]) {
        let removed = RemoteSettingsCleanup.patientListLoaded(.success(patients.map(\.patient_id)), scope: .shared,
                                                             trioStore: KeychainTrioRemoteSettingsStore(), loopStore: KeychainLoopRemoteSettingsStore())
        if !removed.isEmpty {
            NSLog("[REMOTE-SETTINGS] removed stale settings count=%d", removed.count)
        }
    }

    func selectPatient(_ patient: AccessiblePatient) {
        // Nothing of the previous patient stays open: their confirmations and settings close.
        isSettingsPresented = false
        RemoteCommandCenter.shared.cancelConfirmations(exceptPatientID: patient.patient_id)
        selectedConversationID = nil
        selectedConversationPatientID = nil
        selectedConversationRefreshNonce = 0
        conversationOpenedFromNotification = nil
        mealsFocus = nil
        patientEntryDestination = .dashboard(patient)
        refreshRemoteSetup()
    }

    /// Saves "Rok urodzenia" and puts it on the patient on screen and in the list (the tabs open once it is set).
    func saveBirthYear(_ birthYear: Int, patientID: String) async throws {
        guard let apiClient else { return }
        let saved = try await apiClient.setPatientBirthYear(patientID: patientID, birthYear: birthYear)
        accessiblePatients = accessiblePatients.map { patient in
            guard patient.patient_id == patientID else { return patient }
            var updated = patient
            updated.birth_year = saved.birth_year
            return updated
        }
        if case .dashboard(let patient) = patientEntryDestination, patient.patient_id == patientID {
            var updated = patient
            updated.birth_year = saved.birth_year
            patientEntryDestination = .dashboard(updated)
        }
    }

    func showPatientSelection() {
        guard accessiblePatients.count > 1 else {
            return
        }

        stopLiveUpdates()
        isSettingsPresented = false
        RemoteCommandCenter.shared.cancelConfirmations(exceptPatientID: nil)
        patientEntryDestination = .selection(accessiblePatients)
    }

    /// Opens the live event stream of the patient on screen (replacing another patient's).
    func startLiveUpdates(patientID: String) {
        guard let apiClient else { return }
        if liveUpdates?.patientID != patientID {
            liveUpdates?.stop()
            let live = LiveUpdates(patientID: patientID, api: apiClient, transport: eventStreamTransport)
            capabilities.bindLiveUpdates(live, api: apiClient, patientID: patientID)
            // A package handed over to this person (1.0.5): read at once, not at the next launch.
            handoffLiveChanges = live.changes
                .filter { change in if case .changed("remote_settings_handoff", _) = change { return true } else { return false } }
                .receive(on: RunLoop.main)
                .sink { [weak self] _ in self?.handoffAnnounced(handoffID: nil) }
            liveUpdates = live
        }
        if isInForeground {
            liveUpdates?.start()
        }
    }

    /// The stream is closed in the background (iOS would suspend it anyway) and reopened on return; the screens
    /// re-read what they show when it is back.
    func setLiveUpdatesActive(_ active: Bool) {
        isInForeground = active
        if active {
            liveUpdates?.start()
        } else {
            liveUpdates?.stop()
        }
    }

    private func stopLiveUpdates() {
        liveUpdates?.stop()
        liveUpdates = nil
        handoffLiveChanges = nil
        capabilities.reset()
    }

    func openConversationFromDashboard(patientID: String, conversationID: String) {
        conversationOpenedFromNotification = conversationID
        setSelectedConversation(patientID: patientID, conversationID: conversationID, triggerRefreshIfSame: true)
        selectedTab = .conversations
    }

    func setSelectedConversation(patientID: String, conversationID: String, triggerRefreshIfSame: Bool) {
        if selectedConversationPatientID == patientID,
           selectedConversationID == conversationID {
            if triggerRefreshIfSame {
                selectedConversationRefreshNonce += 1
            }
            return
        }

        selectedConversationPatientID = patientID
        selectedConversationID = conversationID
    }

    /// The conversations tab's own choice when it appears (pending question, latest): applied only while the
    /// selection is still the one the tab saw, so it never replaces a conversation a notification opened meanwhile.
    func selectDefaultConversation(patientID: String, conversationID: String, ifSelectionStill seen: String?) {
        let current = selectedConversationPatientID == patientID ? selectedConversationID : nil
        guard current == seen else {
            NSLog("[PUSH-TAP] default conversation skipped, selection changed meanwhile")
            return
        }
        setSelectedConversation(patientID: patientID, conversationID: conversationID, triggerRefreshIfSame: false)
    }

    func refreshPatientEntry() async {
        await loadPatientEntryDestination()
    }

    func handleUniversalLink(_ url: URL) {
        if url.scheme?.lowercased() == PairingLink.scheme {
            receivePairingLink(text: url.absoluteString)
            return
        }
        guard let route = AppRoute.parse(universalLink: url) else {
            return
        }
        Task { @MainActor [weak self] in
            await self?.routes.receive(route)
        }
    }

    /// A notification from the bell opens like the tapped push (conversation, hypo screen, meal or its WBT screen).
    func openNotificationFromHistory(_ pushUserInfo: [AnyHashable: Any]) {
        Task { @MainActor [weak self] in
            await self?.handlePushPayload(pushUserInfo)
        }
    }

    // MARK: - Notification routes

    #if DEBUG
    /// Tests: a signed-in container with these patients (`current` on screen, else the launch choice), not bootstrapped
    /// over the network.
    func prepareForTesting(patients: [AccessiblePatient], current: AccessiblePatient?, authMode: RuntimeAuthMode = .disabledLocal) {
        runtimeAuthMode = authMode
        requiresSignIn = false
        bootstrapped = true
        accessiblePatients = patients
        awaitingPatientList = false
        patientEntryDestination = current.map { .dashboard($0) } ?? PatientLaunchResolver.resolve(patients: patients)
    }
    #endif

    /// The patient list a route is checked against; nil while it is being read (the route is tried again after).
    private var knownPatientIDsForRoutes: [String]? {
        if loadingPatientEntry || awaitingPatientList {
            return nil
        }
        return accessiblePatients.map(\.patient_id)
    }

    /// A route's patient missing from the list on screen: the list is read again (access granted since).
    private func refreshAccessiblePatients() async throws -> [String] {
        guard let apiClient else {
            throw APIClientError.transport("not configured")
        }
        let response = try await apiClient.listAccessiblePatients()
        accessiblePatients = response.patients
        noteVisiblePatients(response.patients)
        userDisplayName = response.user_display_name
        if patientEntryDestination == nil || patientEntryDestination == .empty {
            patientEntryDestination = PatientLaunchResolver.resolve(patients: response.patients)
            patientEntryError = nil
        }
        return response.patients.map(\.patient_id)
    }

    /// Shows a notification's screen: the sheets on screen close, the app switches to the route's patient, then the
    /// tab and the screen open. A remote command being sent is never interrupted: the screen opens once it is sent.
    private func open(_ route: AppRoute) {
        RemoteCommandCenter.shared.whenNotSending { [weak self] in
            self?.show(route)
        }
    }

    private func show(_ route: AppRoute) {
        guard let patient = accessiblePatients.first(where: { $0.patient_id.caseInsensitiveCompare(route.patientID) == .orderedSame }) else {
            return
        }
        let wasCovered = isSettingsPresented || modalTracker.hasOpenModal
        isSettingsPresented = false
        modalTracker.forgetAll()
        notificationDismissal += 1
        let samePatient = currentPatient?.patient_id == patient.patient_id
        if !samePatient {
            NSLog("[PUSH-TAP] switching to the route's patient patientId=%@", patient.patient_id)
            selectPatient(patient)
        }

        routeTask?.cancel()
        pendingBolusTab = nil
        switch route {
        case let .conversation(conversation):
            conversationOpenedFromNotification = conversation.conversationID
            setSelectedConversation(patientID: patient.patient_id, conversationID: conversation.conversationID, triggerRefreshIfSame: true)
            selectedTab = .conversations
        case let .meal(meal):
            selectedTab = .meals
            guard wasCovered else {
                mealsFocus = meal
                break
            }
            // The meal's page may open a sheet of its own (WBT, split bolus): a closing sheet would
            // swallow it, so it waits for the sheets to go.
            routeTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 650_000_000)
                guard !Task.isCancelled else { return }
                self?.mealsFocus = meal
            }
        case .remoteCommands:
            // The patient's own capabilities are read once their tabs appear: until then the dashboard, and the Bolus
            // tab follows as soon as they allow it (a cold start from the widget).
            if samePatient && canGiveRemotely {
                selectedTab = .bolus
            } else {
                selectedTab = .dashboard
                pendingBolusTab = (patient.patient_id, Date().addingTimeInterval(15))
            }
        case .equipment:
            selectedTab = .dashboard
            equipmentRequest = UUID()
        case .patient:
            // Nothing more precise to open (a reminder with no conversation or meal): the patient's start screen.
            selectedTab = .dashboard
        }
    }

    /// The capabilities now allow remote commands: a Bolus tab asked for a moment ago opens.
    func openPendingBolusTab() {
        guard let pending = pendingBolusTab else { return }
        pendingBolusTab = nil
        guard Date() < pending.until, currentPatient?.patient_id == pending.patientID, canGiveRemotely else { return }
        selectedTab = .bolus
    }

    func presentSettings(refresh: (() -> Void)?) {
        settingsRefresh = refresh
        isSettingsPresented = true
    }

    /// "Zapytaj w czacie": a new conversation with an empty draft (nothing is written for the caregiver).
    func startNewChat() {
        newChatRequest = UUID()
        selectedTab = .conversations
    }

    /// The conversations tab took the request (it may have been created only now, after the request was made).
    /// The dashboard opened the equipment list the widget asked for.
    func equipmentRequestHandled(_ request: UUID) {
        if equipmentRequest == request { equipmentRequest = nil }
    }

    func newChatHandled(_ request: UUID) {
        if newChatRequest == request { newChatRequest = nil }
    }

    /// "Otwórz posiłek" on a chat card or in the Bolus tab: the meal of the patient on screen.
    func openMealFromNotification(_ route: MealRoute?) {
        guard let route else { return }
        mealsFocus = route
        selectedTab = .meals
    }

    /// Registers this phone's push token again for every patient (Settings, when the server does not know the device).
    func registerDeviceAgain() async {
        await pushManager?.registerLastToken()
    }

    @discardableResult
    func refreshCapabilities() async -> Bool {
        guard let apiClient, case .dashboard(let patient) = patientEntryDestination else {
            return false
        }
        let answered = await capabilities.refresh(api: apiClient, patientID: patient.patient_id)
        // The patient's loop may be another one now (Trio ⇄ Loop): its own settings decide.
        if answered {
            refreshRemoteSetup()
            // Settings here but remote bolus not usable yet: said once per settings save (launch, return to the app).
            considerRemoteBolusNextStep(patientID: patient.patient_id)
        }
        return answered
    }

    /// The patient's commands go to Loop: the server said so for this patient.
    /// The owner's "Przekaż moje ustawienia Trio/Loop" (device mode): this phone's device key signs, Face ID first.
    func makeHandoffSender() -> RemoteSettingsHandoffSender? {
        guard isDeviceMode, let apiClient, let keys = deviceKeys, let store = devicePairingStore else { return nil }
        return RemoteSettingsHandoffSender(
            api: apiClient, keys: keys, deviceID: { (try? store.loadPairing())?.deviceID },
            trioStore: KeychainTrioRemoteSettingsStore(), loopStore: KeychainLoopRemoteSettingsStore(),
            glucoMindTeamID: GlucoMindPushIdentity.current().teamID,
            confirm: DeviceBiometrics.isAvailable ? { reason in await LocalAuthenticationGate().confirm(reason: reason) } : nil
        )
    }

    /// A push or the live stream said a package was handed to this phone (1.0.5): it is read and offered at once, even
    /// one offered before in this launch (a tapped push asks for it again).
    func handoffAnnounced(handoffID: String?) {
        if let handoffID { handoffOffersShown.remove(handoffID) }
        Task { await refreshHandoffs() }
    }

    // MARK: - "Jeszcze jeden krok" (1.0.5)

    /// Settings for the patient are ready on this phone, but the person's remote bolus is not usable from it: the sheet
    /// once per settings save. `patientID` nil: the patient on screen.
    func considerRemoteBolusNextStep(patientID: String? = nil) {
        guard isDeviceMode, !requiresSignIn, remoteBolusNextStep == nil else { return }
        guard let id = patientID ?? currentPatient?.patient_id else { return }
        nextStepCheck?.cancel()
        nextStepCheck = Task { [weak self] in await self?.checkRemoteBolusNextStep(patientID: id) }
    }

    private func checkRemoteBolusNextStep(patientID: String) async {
        guard let apiClient, let patient = accessiblePatients.first(where: { $0.patient_id.lowercased() == patientID.lowercased() }) else { return }
        let trio = (try? KeychainTrioRemoteSettingsStore().load(patientID: patient.patient_id)) ?? nil
        let loop = (try? KeychainLoopRemoteSettingsStore().load(patientID: patient.patient_id)) ?? nil
        guard let ready = RemoteBolusNextStep.settingsStamp(patientID: patient.patient_id, trio: trio, loop: loop, glucoMindTeamID: GlucoMindPushIdentity.current().teamID, prefersLoop: sendsToLoop(patientID: patient.patient_id)),
              !remoteBolusNextStepPrompts.wasShown(ready.stamp) else { return }
        let phoneReady = thisPhoneHasLocalBolusKey
        // Already working from this phone: nothing to ask (and no request to the server).
        if capabilities.patientID?.lowercased() == patient.patient_id.lowercased(), capabilities.remoteCommands.enabled, phoneReady { return }
        guard let people = try? await apiClient.listPeople(patientID: patient.patient_id), let you = people.you, !Task.isCancelled else { return }
        guard let step = RemoteBolusNextStep.decide(isOwner: people.you_are_owner, state: you.remote_bolus.state, phoneReady: phoneReady, biometrics: DeviceBiometrics.isAvailable) else { return }
        let request = RemoteBolusNextStepRequest(patientID: patient.patient_id, patientName: patient.display_name, loopName: ready.loopName, step: step, stamp: ready.stamp)
        // Right after "Zapisz" the hand-off sheet is up, saying the settings are saved: it goes, this one follows (one
        // sheet at a time).
        if handoffOffer != nil, handoffInbox?.pending.isEmpty ?? true {
            handoffOffer = nil
            try? await Task.sleep(nanoseconds: 600_000_000)
        }
        guard remoteBolusNextStep == nil, !Task.isCancelled else { return }
        remoteBolusNextStep = request
    }

    /// The sheet is on screen: it is not shown again for this settings save.
    func remoteBolusNextStepShown(_ request: RemoteBolusNextStepRequest) {
        remoteBolusNextStepPrompts.markShown(request.stamp)
    }

    /// "Włącz teraz" worked: the capabilities and the Bolus tab follow.
    func remoteBolusNextStepDone() async {
        remoteBolusNextStep = nil
        await refreshCapabilities()
        refreshRemoteSetup()
    }

    /// Reads the packages waiting for this phone; offers the first one not offered yet in this launch.
    func refreshHandoffs() async {
        guard isDeviceMode, !requiresSignIn, let inbox = handoffInbox else { return }
        await inbox.refresh()
        guard handoffOffer == nil, !isSettingsPresented, let next = inbox.pending.first(where: { !handoffOffersShown.contains($0.handoff_id) }) else { return }
        handoffOffersShown.insert(next.handoff_id)
        handoffOffer = next
    }

    /// "Zdalne sterowanie Trio" after a save from the sheet: Settings → the patient → Zdalny bolus.
    func showRemoteBolusSettings(patientID: String) {
        handoffOffer = nil
        settingsInitialRoute = .remoteBolus(patientID)
        isSettingsPresented = true
    }

    // MARK: - Setup guide

    /// After the first patient's tabs and capabilities: the guide once, only right after a new pairing / sign-in of this
    /// phone (its "pending" mark, never set by an app update over an existing session) and only if this person never saw
    /// it here, when no other sheet is up (a recovery code, handed-over settings, an invitation). Not now (another sheet,
    /// another patient) = the mark stays and it is asked again at the next launch.
    func offerSetupGuideIfNeeded(patient: AccessiblePatient) async {
        guard !setupGuideConsidered, setupGuide == nil, let apiClient, let userID else { return }
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        let fixtureStep = environment["GLUCOMIND_UI_FIXTURES_SETUP_GUIDE"]
        // Fixtures and simulator walkthroughs keep their screens unless they ask for the guide.
        let walkthrough = environment[UIPreviewFixtureHTTPClient.environmentKey] == "1" || DeviceModeDebugScene.autoPair || DeviceModeDebugScene.requested != nil
        if let fixtureStep {
            setupGuideConsidered = true
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            presentFixtureSetupGuide(patient: patient, step: fixtureStep)
            return
        }
        if walkthrough { return }
        #endif
        let key = SetupGuideKey.make(server: apiClient.baseURL, userID: userID)
        let store = UserDefaultsSetupGuideSeenStore()
        guard SetupGuideViewModel.shouldOffer(store: store, key: key) else {
            setupGuideConsidered = true
            SetupGuideViewModel.clearPending(store: store, key: key)
            return
        }
        // The tabs first, for a moment (and the capabilities' first answer).
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard !Task.isCancelled, currentPatient?.patient_id == patient.patient_id, !setupGuideBlocked else { return }
        setupGuideConsidered = true
        let access = await SetupGuideAccessLoader.load(api: apiClient, patientID: patient.patient_id, deviceMode: isDeviceMode, capabilities: capabilities, setUpOnThisPhone: remoteSetupComplete)
        guard currentPatient?.patient_id == patient.patient_id, !setupGuideBlocked else {
            setupGuideConsidered = false
            return
        }
        setupGuide = SetupGuideRequest(patient: patient, access: access, key: key)
    }

    /// Ustawienia → Przewodnik konfiguracji: Settings close, then the guide opens for the patient on screen (it changes
    /// no "seen" mark).
    func openSetupGuideFromSettings() {
        guard let apiClient, let patient = currentPatient else { return }
        isSettingsPresented = false
        Task { @MainActor in
            async let access = SetupGuideAccessLoader.load(api: apiClient, patientID: patient.patient_id, deviceMode: isDeviceMode, capabilities: capabilities, setUpOnThisPhone: remoteSetupComplete)
            // After Settings have gone: one sheet at a time.
            try? await Task.sleep(nanoseconds: 600_000_000)
            let read = await access
            guard currentPatient?.patient_id == patient.patient_id else { return }
            setupGuide = SetupGuideRequest(patient: patient, access: read, key: nil)
        }
    }

    /// The guide's "Zezwól na powiadomienia": the same question and token registration as at launch.
    func requestNotificationPermission() async {
        await pushManager?.configureNotifications()
    }

    /// Ustawienia → "Przewodnik po ekranie Bolus": Settings close, the Bolus tab shows and opens its tour (it never
    /// clears the "seen" mark).
    func openBolusTourFromSettings() {
        guard canGiveRemotely else { return }
        isSettingsPresented = false
        selectedTab = .bolus
        bolusTourRequest += 1
    }

    /// The Bolus tour's "seen" mark: this server and person (as the setup guide's); nil while the person is unknown.
    var bolusTourKey: String? {
        guard let apiClient, let userID else { return nil }
        return SetupGuideKey.make(server: apiClient.baseURL, userID: userID)
    }

    /// The setup guide is on screen or still to be offered in this run (its "pending" mark): the Bolus tour waits.
    var setupGuideShowingOrPending: Bool {
        if setupGuide != nil { return true }
        guard !setupGuideConsidered, let key = bolusTourKey else { return false }
        return SetupGuideViewModel.shouldOffer(store: UserDefaultsSetupGuideSeenStore(), key: key)
    }

    /// One of the app's sheets is up (or a notification's screen waits for them): the Bolus tour waits.
    var appModalShowing: Bool {
        if case .selection? = patientEntryDestination { return true }
        #if DEBUG
        if debugScene != nil { return true }
        #endif
        return setupGuideBlocked || remoteBolusNextStep != nil || modalTracker.hasOpenModal
    }

    /// The Bolus tour opens by itself, except in fixtures and simulator walkthroughs (they keep their screens).
    var bolusTourAutoStartAllowed: Bool {
        #if DEBUG
        if runtimeValue(UIPreviewFixtureHTTPClient.environmentKey) == "1" || DeviceModeDebugScene.autoPair || DeviceModeDebugScene.requested != nil { return false }
        #endif
        return true
    }

    /// Another sheet is up or about to be.
    private var setupGuideBlocked: Bool {
        isSettingsPresented || handoffOffer != nil || remoteBolusNextStep != nil || newRecoveryCode != nil || isJoinPresented || incomingPairingLink != nil || incomingPairingError != nil
    }

    #if DEBUG
    /// GLUCOMIND_UI_FIXTURES_SETUP_GUIDE=1 (or remoteControl, notifications, instructions, done: that step first);
    /// GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_ROLE=owner (default) | helper (no remote bolus grant) | observer (glucose only);
    /// GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_LOOP=TRIO | LOOP names the loop (else the capabilities' one).
    private func presentFixtureSetupGuide(patient: AccessiblePatient, step: String) {
        let environment = ProcessInfo.processInfo.environment
        let role = environment["GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_ROLE"] ?? "owner"
        let loop = environment["GLUCOMIND_UI_FIXTURES_SETUP_GUIDE_LOOP"].flatMap(LoopSystemKind.init(rawValue:)) ?? capabilities.loopSystem.system
        let access = SetupGuideAccess(
            remoteControl: role == "owner",
            loopSystem: loop,
            glucoseAlerts: true,
            assistant: role != "observer",
            hasAiPreferences: true
        )
        setupGuide = SetupGuideRequest(patient: patient, access: access, key: nil, startAt: SetupGuideStep(rawValue: step))
    }
    #endif

    func sendsToLoop(patientID: String) -> Bool {
        capabilities.patientID?.lowercased() == patientID.lowercased() && capabilities.remoteCommands.sendsToLoop
    }

    /// The patient's tabs read their capabilities: a failed read (no network yet on launch, the server restarting) is
    /// tried again for a while, or the Bolus tab would stay hidden until the next return to the app.
    func loadCapabilities() async {
        for delay: UInt64 in [0, 2, 5, 10, 20] {
            if delay > 0 { try? await Task.sleep(nanoseconds: delay * 1_000_000_000) }
            if Task.isCancelled { return }
            if await refreshCapabilities() { return }
        }
    }

    /// Asks the server which builds it still supports; a failure keeps the last answer (no banner from a network error).
    func refreshAppConfig() async {
        guard let apiClient else {
            return
        }
        let config: AppConfigResponse
        do {
            config = try await apiClient.getAppConfig()
        } catch {
            // The reason (offline, local network not allowed, server down) is what a "no patients" report needs.
            NSLog("[APP-CONFIG] fetch failed error=%@", String(describing: error))
            return
        }
        NSLog("[APP-CONFIG] min=%d build=%@", config.ios.min_build, AppBuildInfo.current.displayText)
        VoiceTranscriptionSettings.shared.serverTranscription = config.voice?.server_transcription
        updateRequiredMessage = AppUpdatePolicy.updateMessage(build: AppBuildInfo.current, config: config)
    }

    func restoreSessionOnForeground() async {
        guard runtimeAuthMode == .cognito || runtimeAuthMode == .device else {
            requiresSignIn = false
            return
        }

        guard let authProvider else {
            return
        }

        let restored = await authProvider.restoreSession()
        guard restored else {
            sessionEnded()
            return
        }
        requiresSignIn = false
        // A notification that could not open before (no network for the patient list) is tried again.
        await routes.resume()
        await refreshCapabilities()
        await pushManager?.registerLastToken()
    }

    private func handlePushPayload(_ userInfo: [AnyHashable: Any]) async {
        // A tapped hand-off push (1.0.5): the package is read and offered over the patient's screen.
        if let handoff = PushPayloadParser.remoteSettingsHandoff(userInfo: userInfo) {
            handoffAnnounced(handoffID: handoff.handoffID)
        }
        guard let route = AppRoute.parse(pushPayload: userInfo) else {
            return
        }
        LaunchSplashController.shared.hurry()
        await routes.receive(route)
    }

    private func ensureAuthenticatedSession() async -> Bool {
        guard runtimeAuthMode == .cognito || runtimeAuthMode == .device else {
            requiresSignIn = false
            return true
        }

        guard let authProvider else {
            return false
        }

        let restored = await authProvider.restoreSession()
        if restored {
            requiresSignIn = false
        } else {
            sessionEnded()
            requiresSignIn = true
        }
        return restored
    }

    private func loadPatientEntryDestination() async {
        guard let apiClient else {
            return
        }
        defer {
            Task { await refreshHandoffs() }
        }
        defer {
            // The caregiver may have just signed in or been given access: register this phone for notifications.
            if !accessiblePatients.isEmpty {
                Task { await pushManager?.registerLastToken() }
            }
        }

        loadingPatientEntry = true
        patientEntryError = nil
        defer {
            loadingPatientEntry = false
        }

        do {
            let response = try await apiClient.listAccessiblePatients()
            accessiblePatients = response.patients
            noteVisiblePatients(response.patients)
            userDisplayName = response.user_display_name
            userID = response.user_id
            if setupGuidePendingForNextUser {
                setupGuidePendingForNextUser = false
                SetupGuideViewModel.noteNewPairing(store: UserDefaultsSetupGuideSeenStore(), key: SetupGuideKey.make(server: apiClient.baseURL, userID: response.user_id))
            }
            patientEntryDestination = PatientLaunchResolver.resolve(patients: response.patients)
            #if DEBUG
            // Simulator walkthroughs with several patients (DeviceModeDebugScenes.swift): open this one at once.
            if let name = ProcessInfo.processInfo.environment["MELLIS_UI_PATIENT"], let patient = response.patients.first(where: { $0.display_name == name }) {
                patientEntryDestination = .dashboard(patient)
            }
            #endif
        } catch {
            NSLog("[PATIENTS] list failed error=%@", String(describing: error))
            accessiblePatients = []
            patientEntryDestination = nil
            patientEntryError = "Nie udało się wczytać listy pacjentów."
        }
        loadingPatientEntry = false
        awaitingPatientList = false
        // A notification tapped at launch or before signing in opens now (after a failed list it keeps waiting).
        await routes.resume()
    }
}

extension AppContainer {
    /// What "Odłącz ten telefon" does when the server cannot be reached (the confirmation's text).
    static func unpairFromErrorText(server: URL?) -> String {
        let name = server.map { $0.host ?? $0.absoluteString }.map { " (\($0))" } ?? ""
        return "Telefon zapomni połączenie z serwerem Mellis\(name) i zapisane na nim ustawienia zdalnego bolusa. Gdy serwer nie odpowiada, połączenie znika tylko z tego telefonu. Potem połączysz go od nowa (kod QR albo zaproszenie)."
    }
}

private extension AppContainer {
    static func safeConversationID(from userInfo: [AnyHashable: Any]) -> String {
        guard let gluco = userInfo["gluco"] as? [String: Any],
              let conversationID = gluco["conversationId"] as? String else {
            return "n/a"
        }

        let trimmed = conversationID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "n/a" : trimmed
    }
}

struct RootView: View {
    @EnvironmentObject private var container: AppContainer
    /// "Odłącz ten telefon" on "Brak listy pacjentów": asked once more before the pairing is forgotten.
    @State private var showsUnpairConfirmation = false

    var body: some View {
        // Above the screen, not over it: navigation titles and headers keep their place below the banner.
        VStack(spacing: 0) {
            if let message = container.updateRequiredMessage {
                AppUpdateBanner(message: message)
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // Device mode, paired: an invitation link that opened the app (or "Dołącz") joins one more patient.
                .sheet(isPresented: Binding(
                    get: { container.isDeviceMode && !container.requiresSignIn && (container.isJoinPresented || container.incomingPairingLink != nil) },
                    set: { if !$0 { container.isJoinPresented = false; container.incomingPairingLink = nil } }
                )) {
                    JoinInvitationView(initialText: container.incomingPairingLink?.code ?? "")
                }
                // Device mode: remote control settings an owner handed to this phone.
                .sheet(isPresented: Binding(
                    get: { container.isDeviceMode && !container.requiresSignIn && container.handoffOffer != nil && !container.isSettingsPresented },
                    set: { if !$0 { container.handoffOffer = nil } }
                )) {
                    if let inbox = container.handoffInbox {
                        HandoffInboxSheet(
                            inbox: inbox,
                            onShowSettings: { patientID in
                                container.handoffOffer = nil
                                // After this sheet has gone: one sheet at a time.
                                Task { @MainActor in
                                    try? await Task.sleep(nanoseconds: 600_000_000)
                                    container.showRemoteBolusSettings(patientID: patientID)
                                }
                            },
                            onClose: { container.handoffOffer = nil }
                        )
                    }
                }
                // "Jeszcze jeden krok" (1.0.5): after the other sheets, never over them.
                .sheet(item: Binding(
                    get: { container.isSettingsPresented || container.handoffOffer != nil || container.setupGuide != nil || container.newRecoveryCode != nil ? nil : container.remoteBolusNextStep },
                    set: { if $0 == nil { container.remoteBolusNextStep = nil } }
                )) { request in
                    RemoteBolusNextStepSheet(
                        request: request,
                        sharing: container.apiClient.map { DeviceSharingViewModel(patientID: request.patientID, patientName: request.patientName, api: $0, signer: container.deviceSigner, acknowledgement: UserDefaultsDIYAcknowledgementStore()) },
                        onShown: { container.remoteBolusNextStepShown(request) },
                        onDone: { Task { await container.remoteBolusNextStepDone() } },
                        onClose: { container.remoteBolusNextStep = nil }
                    )
                    .presentationDetents([.medium])
                }
                .alert(
                    "Nie można użyć tego linku",
                    isPresented: Binding(
                        get: { container.isDeviceMode && !container.requiresSignIn && container.incomingPairingError != nil },
                        set: { if !$0 { container.incomingPairingError = nil } }
                    )
                ) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(container.incomingPairingError ?? "")
                }
        }
        .environment(\.tourAnchorFrames, container.tourFrames)
        // The spotlight tour over the whole app (the top bar and the tab bar dimmed in place, nothing moves).
        .overlay { SpotlightRootOverlay(controller: container.tourController, frames: container.tourFrames) }
        // Device mode: the recovery code a recovery answered with, shown once.
        .sheet(isPresented: Binding(get: { container.newRecoveryCode != nil }, set: { if !$0 { container.newRecoveryCode = nil } })) {
            if let code = container.newRecoveryCode {
                NewRecoveryCodeSheet(code: code) { container.newRecoveryCode = nil }
            }
        }
        // Every sheet below closes when a notification opens a screen (closesForNotification).
        .environment(\.notificationDismissal, container.notificationDismissal)
        .environment(\.notificationModalTracker, container.modalTracker)
        // "Przewodnik konfiguracji": once after the first patient's tabs, or from Settings. A swipe down closes it too.
        .sheet(item: $container.setupGuide) { request in
            if let apiClient = container.apiClient {
                SetupGuideView(request: request, apiClient: apiClient, deviceMode: container.isDeviceMode) {
                    container.setupGuide = nil
                }
                .environmentObject(container)
            }
        }
        .sheet(isPresented: $container.isSettingsPresented, onDismiss: { container.settingsInitialRoute = nil }) {
            if let apiClient = container.apiClient, let patient = container.currentPatient {
                SettingsView(
                    apiClient: apiClient,
                    currentPatientID: patient.patient_id,
                    currentCapabilities: container.capabilities,
                    signer: container.deviceSigner,
                    deviceID: DeviceIDStore.shared.deviceID,
                    deviceMode: container.isDeviceMode,
                    onRegisterDevice: { await container.registerDeviceAgain() },
                    onRefresh: container.settingsRefresh,
                    onClose: { container.isSettingsPresented = false },
                    initialRoute: container.settingsInitialRoute
                )
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        Group {
            switch PatientLaunchResolver.resolveRootPresentation(
                bootstrapped: container.bootstrapped,
                hasBootstrapError: container.bootstrapError != nil,
                requiresSignIn: container.requiresSignIn
            ) {
            case .loading:
                BrandSpinner()
            case .error where container.isDeviceMode && container.requiresSignIn:
                PairingView()
            case .error:
                ContentUnavailableView {
                    Label(container.requiresSignIn ? "Logowanie nieudane" : "Nie udało się uruchomić aplikacji", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(container.bootstrapError ?? "Spróbuj uruchomić aplikację ponownie.")
                } actions: {
                    if container.requiresSignIn {
                        Button(container.signingIn ? "Logowanie…" : "Zaloguj się ponownie") {
                            Task {
                                await container.signIn()
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(container.signingIn)
                    }
                }
            case .signIn where container.isDeviceMode:
                PairingView()
            case .signIn:
                VStack(spacing: 16) {
                    Image("LogoLarge")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 96, height: 96)
                        .accessibilityHidden(true)
                    BrandWordmark.text()
                        .font(.largeTitle.weight(.semibold))
                        .accessibilityLabel("Mellis")
                    Text("Zaloguj się, aby kontynuować.")
                        .foregroundStyle(.secondary)
                    if let error = container.bootstrapError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    Button(container.signingIn ? "Logowanie…" : "Zaloguj się") {
                        Task {
                            await container.signIn()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(container.signingIn)
                }
                .padding()
            case .patientEntry:
                if container.loadingPatientEntry {
                    BrandSpinner()
                } else if let error = container.patientEntryError {
                    ContentUnavailableView {
                        Label("Brak listy pacjentów", systemImage: "person.crop.circle.badge.exclamationmark")
                    } description: {
                        Text("\(error) Sprawdź połączenie i spróbuj ponownie.")
                    } actions: {
                        Button("Spróbuj ponownie") {
                            Task {
                                await container.refreshPatientEntry()
                            }
                        }
                        .buttonStyle(.borderedProminent)

                        if container.canSignOut {
                            Button("Wyloguj") {
                                Task {
                                    await container.signOut()
                                }
                            }
                        }
                        // A phone paired with a server that no longer exists (1.0.5): not stuck on this screen.
                        if container.canUnpairFromErrorScreen {
                            Button("Odłącz ten telefon", role: .destructive) {
                                showsUnpairConfirmation = true
                            }
                            .accessibilityIdentifier("patients.unpair")
                        }
                    }
                    #if DEBUG
                    // GLUCOMIND_UI_FIXTURES_PATIENTS_ERROR=dialog: the confirmation open (screenshots without tapping).
                    .task {
                        guard ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_PATIENTS_ERROR"] == "dialog" else { return }
                        try? await Task.sleep(nanoseconds: 800_000_000)
                        showsUnpairConfirmation = true
                    }
                    #endif
                    .confirmationDialog("Odłączyć ten telefon?", isPresented: $showsUnpairConfirmation, titleVisibility: .visible) {
                        Button("Odłącz ten telefon", role: .destructive) {
                            Task { await container.unpairThisPhone() }
                        }
                        Button("Anuluj", role: .cancel) {}
                    } message: {
                        Text(AppContainer.unpairFromErrorText(server: container.pairing?.serverURL))
                    }
                } else if let apiClient = container.apiClient {
                    patientEntryView(apiClient: apiClient)
                } else {
                    BrandSpinner()
                }
            }
        }
    }

    /// The patient's tabs: the Tab API on iOS 18 and later, tab items before.
    @ViewBuilder
    private func patientTabs(_ patient: AccessiblePatient, apiClient: APIClient) -> some View {
        let bolusFlow = container.canGiveRemotely ? RemoteCommandCenter.shared.makeFlow(patientID: patient.patient_id, place: .bolusTab, patientName: patient.display_name) : nil
        if #available(iOS 18.0, macOS 15.0, *) {
            TabView(selection: $container.selectedTab) {
                Tab("Dashboard", systemImage: "gauge.with.dots.needle.33percent", value: AppTab.dashboard) {
                    dashboardTab(patient, apiClient: apiClient)
                }
                Tab("Rozmowy", systemImage: "bubble.left.and.bubble.right", value: AppTab.conversations) {
                    conversationsTab(patient, apiClient: apiClient)
                }
                Tab("Posiłki", systemImage: "fork.knife", value: AppTab.meals) {
                    mealsTab(patient, apiClient: apiClient, searchable: true)
                }
                // Only for a caregiver allowed to send remote commands to this patient's Trio (D2).
                if let bolusFlow {
                    Tab("Bolus", systemImage: "syringe", value: AppTab.bolus) {
                        bolusTab(patient, apiClient: apiClient, flow: bolusFlow)
                    }
                }
            }
        } else {
            TabView(selection: $container.selectedTab) {
                dashboardTab(patient, apiClient: apiClient)
                    .tabItem { Label("Dashboard", systemImage: "gauge.with.dots.needle.33percent") }
                    .tag(AppTab.dashboard)
                conversationsTab(patient, apiClient: apiClient)
                    .tabItem { Label("Rozmowy", systemImage: "bubble.left.and.bubble.right") }
                    .tag(AppTab.conversations)
                mealsTab(patient, apiClient: apiClient, searchable: true)
                    .tabItem { Label("Posiłki", systemImage: "fork.knife") }
                    .tag(AppTab.meals)
                if let bolusFlow {
                    bolusTab(patient, apiClient: apiClient, flow: bolusFlow)
                        .tabItem { Label("Bolus", systemImage: "syringe") }
                        .tag(AppTab.bolus)
                }
            }
        }
    }

    private func dashboardTab(_ patient: AccessiblePatient, apiClient: APIClient) -> some View {
        DashboardView(
            patient: patient,
            apiClient: apiClient,
            canChangePatient: container.accessiblePatients.count > 1,
            onShowPatientSelection: {
                container.showPatientSelection()
            },
            onOpenNotification: { pushUserInfo in
                container.openNotificationFromHistory(pushUserInfo)
            },
            onSignOut: {
                await container.signOut()
            },
            equipmentRequest: container.equipmentRequest,
            onEquipmentRequestHandled: { container.equipmentRequestHandled($0) }
        )
    }

    private func conversationsTab(_ patient: AccessiblePatient, apiClient: APIClient) -> some View {
        AppShellView(
            patient: patient,
            apiClient: apiClient,
            selectedConversationID: container.selectedConversationPatientID == patient.patient_id ? container.selectedConversationID : nil,
            selectedConversationRefreshNonce: container.selectedConversationRefreshNonce,
            openedFromNotification: container.selectedConversationPatientID == patient.patient_id ? container.conversationOpenedFromNotification : nil,
            onSelectConversation: { conversationID, triggerRefreshIfSame in
                container.setSelectedConversation(
                    patientID: patient.patient_id,
                    conversationID: conversationID,
                    triggerRefreshIfSame: triggerRefreshIfSame
                )
            },
            onSelectDefaultConversation: { conversationID, seen in
                container.selectDefaultConversation(patientID: patient.patient_id, conversationID: conversationID, ifSelectionStill: seen)
            },
            onShowPatientSelection: {
                container.showPatientSelection()
            },
            onOpenNotification: { pushUserInfo in
                container.openNotificationFromHistory(pushUserInfo)
            },
            onSignOut: {
                await container.signOut()
            },
            onOpenMeal: { mealID in
                container.openMealFromNotification(MealRoute(patientID: patient.patient_id, mealID: mealID))
            },
            remoteBolusFlow: container.canGiveRemotely ? RemoteCommandCenter.shared.makeFlow(patientID: patient.patient_id, place: .chat, patientName: patient.display_name) : nil,
            newChatRequest: container.newChatRequest,
            onNewChatHandled: { container.newChatHandled($0) },
            greetingName: container.userDisplayName
        )
    }

    private func mealsTab(_ patient: AccessiblePatient, apiClient: APIClient, searchable: Bool) -> some View {
        MealsJournalView(
            patientID: patient.patient_id,
            api: apiClient,
            focus: $container.mealsFocus,
            patientName: patient.display_name,
            searchable: searchable,
            actions: MealJournalActions(
                openConversation: { conversationID in
                    container.openConversationFromDashboard(patientID: patient.patient_id, conversationID: conversationID)
                },
                openBolusTab: { container.selectedTab = container.canGiveRemotely ? .bolus : .dashboard },
                openNewChat: { container.startNewChat() }
            )
        ) {
            TopBarTrailingControls(
                apiClient: apiClient,
                patientID: patient.patient_id,
                onShowPatientSelection: {
                    container.showPatientSelection()
                },
                onOpenNotification: { pushUserInfo in
                    container.openNotificationFromHistory(pushUserInfo)
                },
                onSignOut: {
                    await container.signOut()
                }
            )
        }
            .modifier(MealsRemoteBolus(
                wbtFlow: container.canGiveRemotely ? RemoteCommandCenter.shared.makeFlow(patientID: patient.patient_id, place: .wbt, patientName: patient.display_name) : nil
            ))
    }

    private func bolusTab(_ patient: AccessiblePatient, apiClient: APIClient, flow: RemoteBolusFlow) -> some View {
        RemoteBolusTabView(
            viewModel: RemoteBolusViewModel(
                patientID: patient.patient_id,
                api: apiClient,
                flow: flow,
                glucoseHistory: { [apiClient, patientID = patient.patient_id] in
                    (try? await apiClient.getDashboard(patientID: patientID))?.readings ?? []
                }
            ),
            trailingControls: AnyView(TopBarTrailingControls(
                apiClient: apiClient,
                patientID: patient.patient_id,
                onShowPatientSelection: {
                    container.showPatientSelection()
                },
                onOpenNotification: { pushUserInfo in
                    container.openNotificationFromHistory(pushUserInfo)
                },
                onSignOut: {
                    await container.signOut()
                }
            )),
            canChangePatient: container.accessiblePatients.count > 1,
            onShowPatientSelection: {
                container.showPatientSelection()
            },
            onAskInChat: { container.startNewChat() },
            onOpenMeal: { mealID in
                container.openMealFromNotification(MealRoute(patientID: patient.patient_id, mealID: mealID))
            },
            tourHost: BolusTourHost(
                key: { [weak container] in container?.bolusTourKey },
                setupGuideShowing: { [weak container] in container?.setupGuideShowingOrPending ?? false },
                modalShowing: { [weak container] in container?.appModalShowing ?? false },
                request: container.bolusTourRequest,
                autoStartAllowed: container.bolusTourAutoStartAllowed,
                controller: container.tourController
            )
        )
        .id(patient.patient_id)
    }

    @ViewBuilder
    private func patientEntryView(apiClient: APIClient) -> some View {
        switch container.patientEntryDestination {
        case .empty:
            VStack(spacing: 12) {
                Text("Nie masz dostępu do żadnego pacjenta.")
                Button("Odśwież") {
                    Task {
                        await container.refreshPatientEntry()
                    }
                }
                .buttonStyle(.bordered)

                if container.isDeviceMode {
                    Button("Dołącz z kodem zaproszenia") {
                        container.isJoinPresented = true
                    }
                    .buttonStyle(.bordered)
                }

                Button(container.isDeviceMode ? "Odłącz ten telefon" : "Wyloguj") {
                    Task {
                        await container.signOut()
                    }
                }
            }
            .padding()
        case .selection(let patients):
            NavigationStack {
                List {
                    Section {
                        ForEach(patients, id: \.patient_id) { patient in
                            Button {
                                container.selectPatient(patient)
                            } label: {
                                HStack {
                                    Text(patient.display_name)
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            // List rows tint button labels with the accent color; names read as content, not links.
                            .tint(.primary)
                        }
                    } header: {
                        // The logo and the name, as on the sign-in screen, above the question.
                        VStack(spacing: 10) {
                            Image("LogoLarge")
                                .resizable()
                                .scaledToFit()
                                .frame(width: 64, height: 64)
                                .accessibilityHidden(true)
                            BrandWordmark.text()
                                .font(.title.weight(.bold))
                                .accessibilityLabel("Mellis")
                            Text("Wybierz pacjenta")
                                .font(.body)
                                .foregroundStyle(Color.secondary)
                                .accessibilityAddTraits(.isHeader)
                        }
                        .textCase(nil)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 24)
                        .padding(.bottom, 16)
                    }
                }
            }
        case .dashboard(let patient) where patient.needsBirthYear:
            // Required before anything else: the AI states the patient's age from it.
            PatientBirthYearRequiredView(patientName: patient.display_name) { year in
                try await container.saveBirthYear(year, patientID: patient.patient_id)
            }
        case .dashboard(let patient):
            // Texts name the patient's loop (Trio, Loop) from the capabilities.
            LoopSystemEnvironment(capabilities: container.capabilities) {
                patientTabs(patient, apiClient: apiClient)
            }
            .environment(\.liveUpdates, container.liveUpdates)
            .task(id: patient.patient_id) {
                container.startLiveUpdates(patientID: patient.patient_id)
                container.refreshRemoteSetup()
                #if DEBUG
                Task { await container.seedRemoteSettingsIfRequested(patient: patient) }
                Task { await container.runDebugSceneIfRequested(patient: patient) }
                Task { await container.openFixtureScreenIfRequested(patient: patient) }
                #endif
                // The guide does not wait for capability retries (a server that keeps failing): it reads what it needs.
                async let setupGuide: Void = container.offerSetupGuideIfNeeded(patient: patient)
                await container.loadCapabilities()
                await setupGuide
            }
            #if DEBUG
            .sheet(item: $container.debugScene) { scene in
                DeviceModeDebugSceneView(scene: scene, patient: patient, apiClient: apiClient)
            }
            #endif
            // Remote commands switched off (or this phone's setup undone) while the Bolus tab is open: the tab is gone.
            .onChange(of: container.canGiveRemotely) { _, enabled in
                if !enabled && container.selectedTab == .bolus {
                    container.selectedTab = .dashboard
                }
                if enabled { container.openPendingBolusTab() }
            }
            // Another patient's tabs are new views: nothing of the previous patient (view models, a meal page) stays.
            .id(patient.patient_id)
        case .none:
            VStack(spacing: 12) {
                Text("Wczytuję dane…")

                Button("Odśwież") {
                    Task {
                        await container.refreshPatientEntry()
                    }
                }
                .buttonStyle(.bordered)

                Button(container.isDeviceMode ? "Odłącz ten telefon" : "Wyloguj") {
                    Task {
                        await container.signOut()
                    }
                }
            }
            .padding()
        }
    }
}

final class DeviceIDStore {
    static let shared = DeviceIDStore()

    private let key = "gluco.device.id"

    private init() {}

    var deviceID: String {
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }

        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: key)
        return created
    }
}

enum AppTab: Hashable {
    case dashboard
    case conversations
    case meals
    case bolus
}

/// Shown on every screen while this build is older than the server's minimum (GET /v1/app-config).
struct AppUpdateBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrow.down.app.fill")
                .font(.title3)
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Zaktualizuj aplikację")
                    .font(.subheadline.weight(.semibold))
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Ta wersja: \(AppBuildInfo.current.displayText)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.orange.opacity(0.12))
        .accessibilityElement(children: .combine)
    }
}

/// Remote boluses from the Meals tab: the WBT window and a planned part's card are sheets, so they present their own
/// confirmation, from a flow of their own (one sheet at a time).
private struct MealsRemoteBolus: ViewModifier {
    let wbtFlow: RemoteBolusFlow?

    func body(content: Content) -> some View {
        content
            .environment(\.remoteBolusHost, wbtFlow.map { wbtFlow in
                RemoteBolusHost(
                    give: { base in Task { await wbtFlow.prepare(base) } },
                    attach: { AnyView($0.remoteBolusConfirmation(flow: wbtFlow, showsFailureAlert: true)) }
                )
            })
    }
}
