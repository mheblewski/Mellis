# GlucoMind iOS Foundation

## Architecture

App -> Navigation -> APIClient -> ViewModel -> SwiftUI View

PushNotificationManager -> APNs token -> DeviceRegistrationService -> backend /v1/patients/{patientId}/devices

## Authentication boundary

AuthProvider is defined in core and used by APIClient.

Current implementation: Cognito-backed Authorization Code + PKCE, with token persistence in Keychain and automatic token refresh for API calls.

Required environment values for local run:

GLUCOMIND_API_BASE_URL
AUTH_MODE
ALLOW_AUTH_DISABLED_IN_LOCAL

For local MVP without Cognito login:

AUTH_MODE=disabled
ALLOW_AUTH_DISABLED_IN_LOCAL=1

Fail-closed rule: disabled mode is accepted only in debug builds with explicit allow flag. In all other builds, auth falls back to Cognito mode.

For normal Cognito mode:

COGNITO_DOMAIN_URL
COGNITO_CLIENT_ID
COGNITO_REDIRECT_URI
COGNITO_SCOPES

Patient access is always resolved from backend `/v1/me/patients`; route patient IDs from push/deep links are treated only as routing hints.

## Device mode (self-hosted Mellis)

Community builds use device auth (backend `AUTH_MODE=device`, `docs/device-auth-api.md`): no accounts, no
e-mail, no server address in the build. Which mode a build runs:

| Config (`Config.xcconfig` + `Config.local.xcconfig`) | Mode |
|---|---|
| `AUTH_MODE = device` | device |
| `AUTH_MODE = cognito` (the default) with empty `COGNITO_DOMAIN_URL` or `COGNITO_CLIENT_ID` | device |
| `AUTH_MODE = cognito` with the Cognito values set (today's production) | Cognito |
| `AUTH_MODE = disabled` / `local_token` | local development only (Debug) |

So a fresh checkout builds the community app without any setting; production keeps Cognito through its
`Config.local.xcconfig`. The widget follows the same rule (`HomeWidgetData.swift`).

In device mode:

- The first screen of an unpaired phone is the pairing screen: "Zeskanuj kod" (camera), "Wklej link", "Mam kod
  odzyskiwania". `mellis://pair?server=…&code=…` links open the app (URL scheme `mellis` in Info.plist / project.yml).
  `MELLIS_PAIRING_URL` in the launch environment pre-fills the pairing (installer, simulator checks).
- The server URL and device id are stored in the Keychain group shared with the widget (`GMKeychainAccessGroup`,
  `KeychainDevicePairingStore`); `API_BASE_URL` is not used.
- P-256 keys per phone (`DeviceKeys.swift`): the device key, made at pairing, signs the pairing and session
  challenges (no Face ID, so a phone without Face ID / Touch ID pairs too). The bolus key (`.biometryCurrentSet`) is
  made only when the person confirms remote bolus on this phone ("Chcę podawać bolus zdalnie dla …"), registered with
  `POST /v1/me/devices/bolus-key` under the same Face ID, and signs every remote command and the confirmation. A phone
  without biometrics shows why remote bolus is not available there; after a Face ID change "Zdalny bolus → Ustaw na
  tym telefonie" makes a new key. On a phone they live in the Secure Enclave. **Debug simulator builds only** use
  software keys in the Keychain (`SimulatorSoftwareDeviceKeyStore`, Face ID asked through LocalAuthentication), because
  the simulator has no Secure Enclave; `MELLIS_NO_BIOMETRICS=1` (Debug) acts as a phone without Face ID / Touch ID.
- Live Activity (Settings → Ten telefon → Ekran blokady i Dynamic Island): one or two patients, side by side on the lock
  screen; with two the island shows "Oboje" (left/right picked) or "Bliższe zagrożeniu" (docs/device-auth-api.md
  §9). Simulator without a server: `GLUCOMIND_LIVE_ACTIVITY_FIXTURE=two|two-right|two-closer|two-closer-high|two-old`
  (plus the one-patient variants in `LiveActivityController.swift`), then lock the simulator or go home and long-press
  the island; `xcrun simctl io … screenshot` leaves the Dynamic Island out, the simulator tool's screenshot shows it.
- Sessions (15 min) renew 1 min before expiry or on any 401; `DEVICE_NOT_PAIRED` returns to the pairing screen.
- Settings (iOS Settings layout, `SettingsView.swift`; icons on soft brand-tinted tiles by topic, `SettingsIcon` +
  `BrandTint`, patients' avatars in their stable `PatientColor`): the person and this phone at the top ("Ten telefon": server,
  "Połącz kolejny telefon", the bolus key, "Odłącz ten telefon"); "Pacjenci" with one page per patient (profile,
  Nightscout and the loop, "Osoby i udostępnianie", "Zdalny bolus", this phone's notifications about them), "Dodaj
  pacjenta" (with "Dodaj też współwłaścicieli") and "Dołącz kodem zaproszenia"; "Ten telefon" (lock screen and
  Dynamic Island, instructions for Mellis); "Mellis" (manual, "O aplikacji").

Simulator check against a local server, without any loop: Debug builds with `GLUCOMIND_REMOTE_DRY_RUN=1` in the launch
environment show the Bolus tab without Trio/Loop settings and send every command only as far as the server's signature
check and authorization (`DryRunRemoteCommandSender`); nothing is pushed to APNs or a loop.
Bolus tab tour (`SpotlightTour` / `BolusTour` in GlucoMindCore, `SpotlightTourOverlay.swift`): shown once per person on
this phone and server when the Bolus tab first opens (after "Przewodnik konfiguracji", never over a sheet, the keyboard
or a send; marked seen only by "Gotowe" or "Pomiń"; drawn over the whole app, so nothing moves), again from the "?" beside "Podaj / Historia" and Ustawienia → "Przewodnik po ekranie Bolus". Debug
fixtures: `GLUCOMIND_UI_FIXTURES=1 GLUCOMIND_UI_FIXTURES_REMOTE=1 GLUCOMIND_UI_FIXTURES_BOLUS_TOUR=<1-8 or step name>`
open the Bolus tab with the tour at that step (no "seen" mark is changed; add `GLUCOMIND_UI_FIXTURES_BOLUS=<g>` for
typed carbs).
Walkthroughs without tapping (Debug only, `DeviceModeDebugScenes.swift`): `MELLIS_PAIRING_URL=<link>` +
`MELLIS_AUTO_PAIR=1` pair at launch, `MELLIS_UI_SCENE=sharing|invite|grant-self|this-phone|pair-another|add-patient|join|
settings|settings-patient[:<name>]|settings-remote-bolus|settings-this-phone|settings-lock-screen|settings-about|
settings-add-patient|send-bolus:<g>:<j>` opens a screen once the patient shows (`MELLIS_UI_PATIENT=<name>` picks one of
several patients), `MELLIS_SKIP_NOTIFICATION_PROMPT=1` keeps the
permission question away; Face ID in the simulator: `xcrun simctl spawn <udid> notifyutil -p
com.apple.BiometricKit_Sim.pearl.match`.

## Persistent local iOS dev config

Use local xcconfig instead of entering Scheme environment variables by hand.

From repository root:

cp apps/ios/Config.example.xcconfig apps/ios/Config.local.xcconfig

Then edit `apps/ios/Config.local.xcconfig` once with local values.

Important: in `.xcconfig`, avoid literal `//` (it is treated as comment). Use:

API_BASE_URL = http:$(XC_SLASH)$(XC_SLASH)192.168.1.10:3000

For physical iPhone builds, set at minimum:

- `IOS_DEVELOPMENT_TEAM`
- `IOS_BUNDLE_ID` (usually `pl.glucomind.ios`)
- `GLUCOMIND_API_BASE_URL`
- `AUTH_MODE`
- `ALLOW_AUTH_DISABLED_IN_LOCAL`

If you run Cognito mode, also set:
- `COGNITO_DOMAIN_URL`
- `COGNITO_CLIENT_ID`
- `COGNITO_REDIRECT_URI`
- `COGNITO_SCOPES`

Notes:
- `apps/ios/Config.local.xcconfig` is gitignored.
- Do not commit local IPs or secrets.

After changing `apps/ios/project.yml`, regenerate project:

xcodegen generate

If Xcode still shows signing errors, clean build folder (`Shift+Cmd+K`) and run again on a physical device.

## Physical iPhone (Debug, paid Apple Developer team)

Signing is automatic with `IOS_DEVELOPMENT_TEAM` and `IOS_BUNDLE_ID` from `Config.local.xcconfig`. The app keeps its
Push Notifications (`aps-environment`) entitlement; the App ID must have that capability (Xcode enables it on the App
ID when it manages signing and your role allows it). Installing does not need an APNs key; sending pushes does. Real
universal links are optional: add `applinks:<your domain>` (Associated Domains) to the entitlements, set the domain in
`AppLink.host` (GlucoMindCore) and the server's `APP_LINK_ORIGIN`, and host an apple-app-site-association file.

The local API runs with authentication disabled, so never expose it to a shared network. Safe setup: connect the iPhone
to the Mac by USB with Personal Hotspot on (or join the Mac to the iPhone's hotspot), and bind the API only to the
Mac's address on that link (`API_HOST=<Mac address on the hotspot link>`, never `0.0.0.0`). Point `API_BASE_URL` in
`Config.local.xcconfig` to `http://<that address>:<API_PORT>`. On first launch iOS asks for local network access.

Build and install (from the repository root; signing contacts Apple):

    xcodebuild -project apps/ios/GlucoMindiOS.xcodeproj -scheme GlucoMindApp -configuration Debug \
      -destination 'generic/platform=iOS' -derivedDataPath apps/ios/build/DerivedData -allowProvisioningUpdates build
    xcrun devicectl list devices
    xcrun devicectl device install app --device <device-id> \
      apps/ios/build/DerivedData/Build/Products/Debug-iphoneos/GlucoMindApp.app

## Build and test

From repository root:

npm run ios:build
npm run ios:test

## Universal link route

https://app.mellis.invalid/patients/{patientId}/conversations/{conversationId} (`AppLink.origin`)

Default runtime navigation is event-driven:
- push payload -> conversation route
- universal/deep link -> conversation route

Bootstrap conversation is disabled by default and is intended only for local development fallback.
