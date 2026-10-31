# Device auth and setup API (self-hosted Mellis, stages 2-3 server)

Server side of self-hosted Mellis (device pairing instead of accounts), used by the iOS app. Migrations
`091_self_hosted_device_auth.sql`,
`092_device_bolus_key_optional.sql` (step 1: pairing without Face ID, the bolus key registered with the first remote
bolus confirmation) and `093_remote_settings_handoffs.sql` (step 2: an owner hands their loop settings to another
person's phone, §8). Migration `094_live_activity_two_patients.sql` (§9) is not device-auth specific: the Live Activity
for two patients.
`AUTH_MODE=device` lives next to Cognito: in any other mode every route below answers 404 and nothing of the Cognito
path changed.

Errors are problem+json as everywhere (`{ "code": "…", "status": …, "title": "…" }`); codes are listed per route.

## Server configuration (`.env`)

| Variable | |
|---|---|
| `AUTH_MODE=device` | paired devices, no `COGNITO_*` |
| `NIGHTSCOUT_TOKEN_ENCRYPTION_KEY` | required (patients' Nightscout tokens are stored encrypted) |
| `SETUP_CODE` | ≥ 16 characters, written by the installer (`mellis-admin generate-code`); void once the first owner's phone pairs |
| `PUBLIC_BASE_URL` | required for pairing and invitation links (the address put into their QR codes; the installer always sets it). Never taken from the request's Host / X-Forwarded-Host: unset, link creation answers 503 `PUBLIC_BASE_URL_MISSING` (only a request made on the server itself to `localhost` gets a `http://localhost:…` link, for development) |
| `NIGHTSCOUT_ALLOWED_HOSTS` | optional; a Nightscout on the same Docker network (`nightscout`) must be listed. When set, only listed hosts are accepted |
| `APNS_BUNDLE_ID` | per server is enough (one family = one Team ID = one bundle ID `pl.mellis.<TeamID>`; the APNs host is found per token) |

Server CLI, compiled into the image (no tsx): `node dist/apps/api/src/cli/mellis-admin.js`
`generate-code` · `setup-status` · `check-ai` · `owners` · `reset-owner [--name Ania | --user <id>]` · `ai-budget --total 20 --max-calls 2000
[--monthly]` (creates the AI budget ledger at `AI_EXPERIMENT_BUDGET_LEDGER_PATH` that the worker requires for a paid
provider) · `ai-limit --total 15` (the monthly limit: creates the monthly ledger or changes its limit, spending kept) ·
`ai-status` · `patients` · `check-nightscout` / `set-nightscout --patient <id>` (URL and token from
`MELLIS_NIGHTSCOUT_URL` / `MELLIS_NIGHTSCOUT_TOKEN` in the environment, never on the command line; set replaces the
stored source after a restore and switches off the patient's source rows without an address or token) ·
`recovery-code [--user <id>]` (a new recovery code for the first owner, else the longest-standing owner, or that owner). Output is one JSON line. The server tool `mellis` (`scripts/install-server.sh`, installed as `mellis`) wraps them: shell access = owner.

Monthly AI limit: a ledger with `period: { kind: "MONTHLY", time_zone, month }` counts `total_budget` and `max_calls`
per calendar month in the server's `TZ`; the first read or write in a new month starts it over (old months in
`history`). `GET /v1/patients/:id/capabilities` adds `ai: { limit_reached, resets_at } | null` (null without paid AI):
reached when less than `AI_EXPERIMENT_MAX_COST` (one call's worst case) or no call is left.

## HTTP limits and the proxy (`apps/api/src/http-setup.ts`)

- **Rate limits** of the public routes, per client IP (in-memory token buckets, at most 10 000 kept, least recently
  used dropped; a restart starts them full). Over the limit: `429` problem+json `RATE_LIMITED` with `Retry-After`
  (seconds).

  | Routes | Burst | Refill |
  |---|---|---|
  | `POST /v1/pair`, `POST /v1/setup/recover` | 5 | 10 / min |
  | `POST /v1/setup/*` (patients, owner, ai, nightscout-check, pairing-code) | 10 | 10 / min |
  | `GET /v1/setup` (install-app.sh polls it every 3 s) | 30 | 60 / min |
  | `POST /v1/auth/challenge`, `POST /v1/auth/session` | 15 | 30 / min |
  | `POST /v1/devices/release` | 5 | 10 / min |

  `GET /v1/app-config` and every route with a session are not limited.
- **Client IP / proxy trust**: Express `trust proxy = "loopback, uniquelocal"`. `X-Forwarded-For` counts only when the
  direct peer is loopback or a private address (127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
  fc00::/7): Caddy and cloudflared on the compose network, or a host proxy reaching the published `127.0.0.1` port
  through Docker's gateway. The client is the rightmost address that is not such a proxy, so a forged header changes
  nothing. A peer with a public address (a Mikrus subdomain's proxy, a port published to the internet) is the client
  itself: everyone behind it shares one bucket. A proxy of your own must therefore sit on a private address and set
  `X-Forwarded-For`; a client on the same private network as the API (a port published at home) is trusted too.
- **Body size**: JSON and form bodies at most 100 kB (`413` problem+json `PAYLOAD_TOO_LARGE`; malformed JSON `400`
  `INVALID_JSON`). Larger only where needed: chat and meal photos and voice transcription 6 MB (base64 in JSON),
  `POST /v1/patients/:id/remote-settings-handoffs` 512 kB. Caddy allows 8 MB, so the API answers the size error.
- **CORS** is off: only the native app and the installers' curl call the API; browsers get no CORS headers.
- **`PUBLIC_BASE_URL`** is the only source of the address in pairing / invitation links (see the table above).

## Keys on the phone

Up to two Secure Enclave P-256 keys per paired device, never exported:

- **device key** (`kSecAttrTokenIDSecureEnclave`, access `.privateKeyUsage`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  so the widget / background refresh can renew a session): created at pairing, signs the pairing and session
  challenges. No Face ID: a phone without Face ID / Touch ID pairs and uses everything but remote bolus.
- **bolus key** (access `[.privateKeyUsage, .biometryCurrentSet]`): created only when the person confirms a remote
  bolus grant on this phone ("Chcę podawać bolus zdalnie dla …", Face ID) and registered then (§4,
  `POST /v1/me/devices/bolus-key`). It signs every remote command and the remote bolus confirmation. Face ID is
  enforced by the key itself; the server checks the signature, so a command without Face ID cannot exist. A phone
  without biometrics never gets one: the app says why remote bolus is not available there. After a Face ID change the
  key stops working; the app makes and registers a new one (the grant and its confirmation stay).

Both keys also decrypt remote settings handed over by an owner (§8, ECIES): the bolus key when the phone has one
(Face ID), else the device key.

Public keys go to the server as base64 of `SecKeyCopyExternalRepresentation` (X9.63, 65 bytes `04‖X‖Y`). Signatures:
base64 of `SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data)` (DER). Messages are UTF-8 bytes.

Codes (pairing, invitation, recovery) are Crockford base32 groups (`7KQ2M-9XH4T-…`); the server ignores case, spaces
and dashes and reads O as 0, I/L as 1.

## QR / link

`mellis://pair?server=<https://…>&code=<code>` — the same for the setup pairing, another phone of the same person,
an invitation and `reset-owner`. The app stores `server` in the Keychain group shared with the widget; it never comes
from the build any more. No universal link / associated domain needed (`applinks` optional).

## 1. Setup (stage 2) — header `X-Mellis-Setup-Code: <SETUP_CODE>`

Used by the setup page (stage 5) or a script; works only until the first owner's phone pairs.

- `GET /v1/setup` (public) → `{ auth_mode: "device", setup: "OPEN" | "COMPLETED", setup_code_configured }`;
  with a valid code while open also `patients: [{ patient_id, display_name, birth_year }]`, `first_owner_named`.
- `POST /v1/setup/patients` `{ display_name, birth_year, nightscout: { url, token } }` → 201
  `{ patient: { patient_id, display_name, birth_year }, nightscout: { base_url, last_reading, uploader, units, timezone } }`.
  The Nightscout is tested before anything is stored: read-only access token (exchanged for a JWT), a reading in the
  last 24 h, public address (resolved and pinned at connect time, no redirects, capped bodies). Errors 422
  `NIGHTSCOUT_ADDRESS_INVALID | NIGHTSCOUT_HOST_NOT_ALLOWED | NIGHTSCOUT_UNREACHABLE | NIGHTSCOUT_TOKEN_MISSING |
  NIGHTSCOUT_TOKEN_INVALID | NIGHTSCOUT_TOKEN_ADMIN | NIGHTSCOUT_TOKEN_NOT_READ_ONLY | NIGHTSCOUT_NO_RECENT_READINGS`,
  409 `NIGHTSCOUT_ALREADY_USED`. Meal history and loop actions start now (what `bootstrap-patient.sql` did).
- `POST /v1/setup/owner` `{ first_name }` → 201 `{ user_id, first_name, pairing: { code, expires_at, pairing_url },
  recovery_code }`. The first owner owns every patient so far (and those added later during setup). 10-minute code;
  the recovery code is shown only here (a repeat replaces both). 409 `SETUP_NEEDS_PATIENT`.
- `POST /v1/setup/ai` `{ provider: "anthropic" | "openai", api_key, openai_api_key? }` → 200 `{ env: { AI_PROVIDER,
  ANTHROPIC_API_KEY?, OPENAI_API_KEY? }, capabilities: { knowledge_search_mode, server_voice_transcription, … },
  checked }`. Questions (owner decision 2026-10-28, plan stage 7): first "Kto ma odpowiadać: Claude (Anthropic) czy
  OpenAI?" and that key. With OpenAI the same key also serves knowledge search and voice: no second question
  (`openai_api_key` is ignored). With Claude the optional OpenAI key ("lepsze wyszukiwanie w bazie wiedzy i
  rozpoznawanie mowy na serwerze, koszt to grosze miesięcznie"; skipped: word-only search BM25, voice on the phone).
  Each key is checked with a free model-list call; 422 `AI_KEY_INVALID | AI_KEY_UNREACHABLE | AI_KEY_MISSING` with the
  key in the title (`"AI_KEY_INVALID: OPENAI_API_KEY"`), `AI_PROVIDER_INVALID`. The server stores no key: the setup
  page writes `env` into `.env` (with the budget settings and `mellis-admin ai-budget`) and restarts. Capabilities come
  from `infra/config/ai-capabilities.ts`.
  On the server: `mellis-admin check-ai` checks the keys already in the environment (`AI_PROVIDER`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`), never on the command line.
- `POST /v1/setup/nightscout-check` `{ url, token }` → 200 `{ nightscout: { base_url, last_reading, uploader, units,
  timezone } }`: the same test as `setup/patients`, nothing stored (the installer shows the reading before asking the
  name). Same 422 / 409 codes.
- `POST /v1/setup/pairing-code` → 201 `{ user_id, pairing: { code, expires_at, pairing_url } }`: a fresh 10-minute
  pairing code for the first owner named by `setup/owner`, **without** replacing the recovery code; earlier unused setup
  pairing codes stop working. This is what `install-app.sh` calls with the "Kod konfiguracji" (= `SETUP_CODE`, printed
  by the installer) right before the app's first start, then passes `pairing_url` to the app. 409 `SETUP_NEEDS_OWNER`
  (no owner named yet), `SETUP_COMPLETED` once the first phone paired (the code is void: `mellis` → Połącz telefon
  właściciela).
- Every setup route: 401 `SETUP_CODE_INVALID`, 409 `SETUP_COMPLETED`, 503 `SETUP_CODE_NOT_CONFIGURED`.

More patients later: `POST /v1/patients` (an owner's device session), same body as `setup/patients` plus optional
`co_owner_user_ids: [user_id, …]` ("Dodaj też współwłaścicieli"); the caller owns it. Each co-owner must currently own
a patient the caller owns (`GET /v1/me/co-owners` lists them: `{ people: [{ user_id, display_name, patients:
[{ patient_id, display_name }] }] }`), else 422 `CO_OWNER_NOT_ALLOWED` (checked before the Nightscout test and again in
the transaction); the caller and repeats are dropped, at most 9. Co-owners get every permission except
`remote_commands`: remote bolus still needs an owner's grant per person and that person's own confirmation. The answer
adds `co_owner_user_ids` (as applied). 403 `NOT_AN_OWNER` for an invited helper.

Patients created in device mode (setup or `POST /v1/patients`) start with `remote_control = {"enabled": true}` (the
patient's switch of migration 045); the per-person grant and confirmation still gate every command. Cognito patients
keep migration 045's default (off).

## 2. Pairing (public)

`POST /v1/pair`

```json
{
  "code": "7KQ2M-9XH4T-…",
  "first_name": "Ewa",                       // optional, invitations only (else the inviter's name for them)
  "device": { "name": "iPhone Ewy", "public_key": "<b64>", "client_device_id": "<the app's push device id>" },
  "signature": "<device key over M>"
}
```

`M = "mellis-pair-v2\n" + normalized code + "\n" + public_key` (normalized: upper case, no dashes/spaces). No bolus key
and no Face ID at pairing. Backward compatible: an app from before step 1 that still sends `device.bolus_public_key` and
`bolus_signature` signs `"mellis-pair-v1\n" + code + "\n" + public_key + "\n" + bolus_public_key` with both keys,
and its bolus key counts as registered. → 201 `{ device_id, user: { user_id, display_name }, patients: [...], session: { access_token,
token_type: "Bearer", expires_at } }`. Errors: 401 `PAIRING_CODE_INVALID` (unknown, used, expired, withdrawn),
401 `PAIRING_SIGNATURE_INVALID`, 422 `PUBLIC_KEY_INVALID`, 409 `DEVICE_ALREADY_PAIRED` (key reused).

What the code does: setup → the first owner (and the setup code is void from now on); invitation → a new person with
the invitation's permissions joins the patient; another phone / `reset-owner` → the same person.

`client_device_id` is the id the app already sends to `POST /v1/patients/:id/devices`; revoking the device stops
those push rows.

## 3. Sessions (public)

1. `POST /v1/auth/challenge` `{ device_id }` → `{ challenge_id, nonce, expires_at }` (2 min, single use).
   401 `DEVICE_NOT_PAIRED` for an unknown or revoked device → the app shows pairing again.
2. `POST /v1/auth/session` `{ device_id, challenge_id, signature }`, device key over
   `"mellis-session-v1\n" + device_id + "\n" + challenge_id + "\n" + nonce` → `{ access_token: "mls_…",
   token_type: "Bearer", expires_at }` (15 min). 401 `DEVICE_AUTH_FAILED` (the challenge is used up either way).

Every other route takes `Authorization: Bearer mls_…`; a 401 means: get a new session (challenge again). Revoking a
device ends its sessions at once. Only SHA-256 of tokens and codes is stored. SSE streams are checked at connect.

## 4. Own devices, more phones, joining another patient (session)

- `GET /v1/me/devices` → `{ devices: [{ device_id, user_id, name, created_at, last_seen_at, this_device }] }`
- `DELETE /v1/me/devices/:deviceId` → 204 (a lost phone; this one before handing it over)
- `POST /v1/me/devices/bolus-key/challenge` → 201 `{ challenge_id, nonce, expires_at }` (purpose `BOLUS_KEY`, 2 min,
  single use), then `POST /v1/me/devices/bolus-key` `{ challenge_id, bolus_public_key, signature, bolus_signature }` →
  200 `{ device_id, bolus_key_registered_at }`. Both keys sign
  `B = "mellis-bolus-key-v1\n" + device_id + "\n" + challenge_id + "\n" + nonce + "\n" + bolus_public_key`: the
  device key proves the phone, the new bolus key (Face ID) proves possession. A repeat replaces the key (Face ID
  changed). 403 `BOLUS_KEY_SIGNATURE_INVALID` (the challenge is used up either way), 422 `PUBLIC_KEY_INVALID` (not a
  P-256 point, or the device key itself), 409 `DEVICE_ALREADY_PAIRED` (key used by another phone).
  `GET /v1/me/devices` rows carry `has_bolus_key`.
- `POST /v1/me/pairing-codes` → 201 `{ code, expires_at, pairing_url }` (10 min): QR for another phone of the same person
- `POST /v1/me/invitations/accept` `{ code }` → `{ patient_id, member }`: an already paired person joins one more patient
- `GET /v1/me/patients` as before (people have only a first name; `user_display_name`)

## 5. People of a patient (session; owners manage)

Permissions are the 090 model: `glucose_alerts` ("Glukoza i alarmy"), `ai_chat_meals` ("Rozmowy z AI i posiłki"),
`manage_sharing` (owner; always has both), `remote_commands` (granted by an owner, counts only after the grantee's
signed confirmation, needs `ai_chat_meals`). A member without `ai_chat_meals` gets only glucose routes
(capabilities, dashboard, notifications, devices, events) — others 403 `PERMISSION_DENIED`.

- `GET /v1/patients/:id/people` → `{ patient_id, you_are_owner, people: [{ user_id, display_name, is_owner,
  permissions, remote_bolus: { granted_by, granted_at, confirmed_at, effective }, is_you, devices?: [...] }],
  invitations: [{ invitation_id, first_name, permissions, created_at, expires_at }] }` (devices and invitations for
  owners only).
- `POST /v1/patients/:id/invitations` `{ first_name, permissions: { glucose_alerts, ai_chat_meals, manage_sharing,
  remote_commands } }` → 201 `{ invitation, pairing: { code, expires_at, pairing_url } }`. Valid 7 days, single use,
  at most 10 people (members + open invitations). 422 `INVALID_PERMISSIONS` (nothing on, or remote without AI),
  409 `PEOPLE_LIMIT_REACHED`, 403 `NOT_AN_OWNER`.
- `DELETE /v1/patients/:id/invitations/:invitationId` → 204 (its code stops working)
- `GET /v1/patients/:id/nightscout` (any member, glucose scope) → `{ patient_id, base_url, last_reading_at }`: the
  address and the newest imported reading, for Settings → the patient's page.
- `PUT /v1/patients/:id/people/:userId` `{ permissions: { …any subset } }` → `{ member }`. `remote_commands: true` is a
  new grant waiting for the person's confirmation (for someone already granted, confirmed or not, it changes nothing:
the grant and confirmation stay); switching `ai_chat_meals` off, demoting the granter or removing
  them clears grants (sharing audit #6). 409 `LAST_OWNER`.
- `DELETE /v1/patients/:id/people/:userId` → 204 (an owner removes someone, or anyone leaves)
- `DELETE /v1/patients/:id/people/:userId/devices/:deviceId` → 204 (an owner revokes a member's phone)

## 6. Signed remote bolus (session + bolus key)

1. `POST /v1/patients/:id/signing-challenges` `{ purpose: "REMOTE_BOLUS" | "REMOTE_BOLUS_CONFIRM" }` → 201
   `{ challenge_id, nonce, expires_at, patient_id, patient_name }` (2 min, single use). Ask for it when the
   confirmation sheet opens. `REMOTE_BOLUS` only for a person whose remote bolus counts (granted by a current owner
   and confirmed): 403 `REMOTE_BOLUS_NOT_PERMITTED`; and only on a phone with a registered bolus key: 403
   `BOLUS_KEY_REQUIRED` (the app offers to set it up). `REMOTE_BOLUS_CONFIRM` for any member, also before the bolus
   key exists.
2. The app shows the confirmation naming the patient, e.g. "Podać 2,5 j dla Janka?", Face ID unlocks the bolus key,
   which signs the JSON bytes:

```json
{ "v": 1, "type": "remote_command", "challenge_id": "…", "nonce": "…", "device_id": "…",
  "patient_id": "…", "patient_name": "Janek", "insulin_u": 2.5, "carbs_g": 30,
  "confirmation": "Podać 2,5 j dla Janka?" }
```

3. `POST /v1/patients/:id/remote-commands` with the usual body plus
   `"device_authorization": { "payload": "<base64url of the exact signed bytes>", "signature": "<b64 DER>" }`.

The server checks, before authorizing: signature by this session's device's **bolus** key; `device_id`, `patient_id`
match the session and path; `patient_name` equals the stored name (the declined form in `confirmation` is the app's;
the server stores it as shown); `insulin_u` and `carbs_g` equal the request's (±0.001); the challenge is fresh, for
this device and patient, and used now (no replay). 403 `REMOTE_COMMAND_SIGNATURE_REQUIRED` (missing),
`BOLUS_KEY_REQUIRED` (this phone has no bolus key) or `REMOTE_COMMAND_SIGNATURE_INVALID`. The verified payload, signature and confirmation text are stored on the command
(`remote_commands.device_authorization`). Warnings are acknowledged as before (preview `warnings[].key`); a 409
`REMOTE_COMMAND_WARNINGS_CHANGED` needs a new challenge and Face ID (the signature was used). Every source is signed
(Bolus tab, cards, new meal, WBT, planned part, rescue carbs). The server still sends nothing to Trio/Loop: the phone
does, as today.

Grantee confirmation of a remote bolus grant (the app: confirm challenge + bolus key challenge, a new bolus key when
this phone has none, one Face ID signing both B and the payload below, register the key, then confirm): purpose
`REMOTE_BOLUS_CONFIRM`, payload
`{ "v": 1, "type": "remote_bolus_confirm", "challenge_id", "nonce", "device_id", "patient_id", "patient_name",
"confirmation": "Chcę podawać bolus zdalnie dla Janka" }` → `POST /v1/patients/:id/remote-bolus/confirm`
`{ device_authorization }` → `{ member }` (409 `REMOTE_BOLUS_NOT_GRANTED`, 403 `BOLUS_KEY_REQUIRED`; the challenge
is not used up by a refused key, so the app registers the key and sends the same confirmation again).

## 7. Recovery

- Recovery code (shown once at setup): `POST /v1/setup/recover` `{ recovery_code, device: {…}, signature }` (the
  device key signs `pairingMessage(recovery_code, public_key)`, v2 as in pairing; v1 with both keys still accepted) → 201 as pairing, plus a new `recovery_code`
  (the old one stops working). Pairs into the first owner while they still own a patient; 401 `RECOVERY_CODE_INVALID`.
  Other phones stay paired: revoke lost ones from `GET /v1/me/devices`.
- Shell access: `mellis-admin reset-owner` → `{ code, expires_at, pairing_url, user_id, display_name }` for the first
  owner (else the longest-standing owner); `--name Ania` makes a new person owner of every patient; `--user <id>` pairs
  that owner (403-style `NOT_AN_OWNER` otherwise). `mellis-admin owners` lists the owners (name, owner since, patients,
  devices, Cognito identities, `has_login_history`, `last_active_at`, `recovery_person`) so the server tool asks
  "Kogo połączyć?" when there is more than one (a restored database may hold a leftover test person, created first).

## 8. Remote settings hand-off (step 2; session, owners send)

Every person with remote bolus needs the loop's remote-command settings on their own phone (Trio: Shared Secret + APNs
`.p8` + Key ID; Loop: the One-Time Password QR's `otpauth://` URL + `.p8` + Key ID (+ Team ID); optionally the answer
key; the limits). "Przekaż moje ustawienia Trio/Loop" lets an owner whose phone has them complete (the Trio / Loop
confirmed, limits reviewed) hand them over so the other person types nothing. **End to end:** the owner's phone
encrypts one copy per recipient phone; the server stores ciphertext and a signature only, cannot read them and never
logs them.

### Crypto

- **Encryption:** ECIES, `SecKeyCreateEncryptedData(publicKey, .eciesEncryptionCofactorVariableIVX963SHA256AESGCM,
  plaintext)` to the recipient phone's P-256 key (the request text said `SecKeyCreateEncryptedMessage`; the Security
  framework's function is `SecKeyCreateEncryptedData`). Output: the ephemeral public key (65 bytes, X9.63) ‖
  ciphertext ‖ 16-byte GCM tag; the recipient decrypts with `SecKeyCreateDecryptedData` and its Secure Enclave key.
- **Which key decrypts:** the phone's **bolus key** when it has one (Face ID enforced by the key: the settings open
  only with Face ID, like a bolus), otherwise its **device key** (`recipient_key: "device"`, no Face ID). The device
  key is the fallback only while the person has not confirmed remote bolus on that phone yet (no bolus key), so an
  owner can hand the settings over right after granting. A package stays encrypted to the key it was made for: one
  sent to the device key still opens after the bolus key is registered; a new hand-off then goes to the bolus key.
- **Sender:** the owner's **device key** signs (DER ECDSA P-256 / SHA-256, as everywhere here; the owner's phone asks
  Face ID through LocalAuthentication before anything leaves when the phone has biometrics):

  `S = "mellis-remote-settings-v1\n" + patient_id + "\n" + from_device_id + "\n" + to_device_id + "\n" + loop_kind +
  "\n" + recipient_key + "\n" + ciphertext` (ciphertext as its canonical base64, the exact string sent; ids lower-case
  as the server lists them). The server verifies S on upload with the sending session's device key; the recipient
  verifies it again with `from_device_public_key` **before decrypting** (a forged package never asks Face ID).
  The sender key comes from the server, so this proves "a paired phone of this owner", not more: a malicious server
  could substitute both (documented limit; no out-of-band key check).
- **Recipient binding:** the plaintext names `to_device_id`, the patient, the sending device and the loop; the phone
  refuses a package whose plaintext differs from its envelope or names another device, even if it decrypts.

### Plaintext (byte-exact, UTF-8 JSON, keys in this order, no spaces; strings JSON-escaped without escaping `/`)

```json
{"v":1,"type":"remote_settings_handoff","patient_id":"…","patient_name":"Zosia","from_user_id":"…","from_name":"Tomek",
 "from_device_id":"…","to_device_id":"…","loop_kind":"trio","created_at":"2026-10-29T08:00:00.000Z",
 "settings":{"shared_secret":"…","apns_key_id":"KEYID12345","apns_key_p8":"-----BEGIN PRIVATE KEY-----\n…",
 "return_key_id":null,"return_key_p8":null,"max_bolus_u":"5","max_carbs_g":100,"bolus_increment_u":"0.05",
 "pinned":{"token_hash":"<sha256 hex of the loop phone's push token>","bundle_id":"…","team_id":"…"}}}
```

(shown wrapped; the real bytes are one line). Loop: `"loop_kind":"loop"` and `settings` starts
`{"otp_url":"otpauth://…","apns_key_id":…,"apns_key_p8":…,"team_id":"…"|null,"return_key_id":…` (rest as Trio).
Amounts are decimal strings (`"max_bolus_u":"4.5"`), never binary floats. `pinned` is the owner's confirmed Trio / Loop
(the hash the app already keeps, never the token). Pinned by `RemoteSettingsHandoffTests` (iOS) and
`device-crypto.spec.ts` (S).

### Endpoints

- `GET /v1/patients/:id/people/:userId/handoff-devices` (owners) → `{ patient_id, user_id, display_name, devices:
  [{ device_id, name, recipient_key: "bolus" | "device", encryption_public_key }] }`: the person's paired phones
  (not the caller's own), each with the key to encrypt to. 403 `NOT_AN_OWNER`, 404 `NOT_A_MEMBER`, 409
  `REMOTE_BOLUS_NOT_GRANTED` (no grant from a current owner, confirmed or waiting).
- `POST /v1/patients/:id/remote-settings-handoffs` (owners) `{ to_user_id, loop_kind: "trio" | "loop", packages:
  [{ to_device_id, recipient_key, ciphertext, sender_signature }] }` (1-10 packages) → 201 `{ handoffs: [{ handoff_id,
  to_device_id, recipient_key, created_at, expires_at }] }`. Checks: owner; S by this session's device key (403
  `HANDOFF_SIGNATURE_INVALID`); ciphertext canonical base64, 82 B-16 KiB, starting 0x04 (422 `HANDOFF_PAYLOAD_INVALID`);
  in one transaction the recipient's grant (409 `REMOTE_BOLUS_NOT_GRANTED`), each device the recipient's and paired
  (404 `DEVICE_NOT_FOUND`), `recipient_key` the key it has now (409 `HANDOFF_KEY_CHANGED`: read the devices again).
  Not to oneself or one's own phone (422). A newer package replaces an unfetched one for the same patient and phone.
  Valid **7 days**.
- `GET /v1/patients/:id/remote-settings-handoffs` (owners) → `{ handoffs: [view] }`: waiting and fetched (receipts,
  `consumed_at`) until they expire; no ciphertext. `DELETE …/:handoffId` (owners) → 204: withdraws an unfetched one
  (404 `HANDOFF_NOT_FOUND`).
- `GET /v1/me/remote-settings-handoffs` → `{ handoffs: [view] }`: waiting for **this session's phone** only.
- `POST /v1/me/remote-settings-handoffs/:id/consume` → `view + { ciphertext, sender_signature }`, **once**: the same
  transaction sets `consumed_at` and drops ciphertext and signature (the row stays as the owner's receipt until it
  expires). Any other phone, a second fetch, an expired or withdrawn one: 404 `HANDOFF_NOT_FOUND`.
- `DELETE /v1/me/remote-settings-handoffs/:id` → 204: "Odrzuć" (an unfetched package of this phone).

`view` = `{ handoff_id, patient_id, patient_name, from_user_id, from_name, from_device_id, from_device_public_key,
to_user_id, to_name, to_device_id, to_device_name, loop_kind, recipient_key, created_at, expires_at, consumed_at }`.

Delivered (listed or fetched) only while the sender still owns the patient, both phones are paired (the bolus key
still registered for `recipient_key: "bolus"`), and the recipient keeps the grant the package was sent under (taking
the grant away and giving it again hides older packages). Expired rows are deleted on the next hand-off read. Audit
events: `REMOTE_SETTINGS_HANDED_OVER`, `…_FETCHED`, `…_REJECTED`, `…_REVOKED` (ids only).

### In the app

- Owner: Ustawienia → pacjent → Osoby i udostępnianie → osoba (with remote bolus granted) → "Przekaż moje
  ustawienia Trio/Loop" (Face ID), also offered in a dialog right after "Zapisz" switches remote bolus on. Disabled with
  "Najpierw ustaw zdalne sterowanie na tym telefonie" when this phone's settings are not complete. Receipts per phone
  ("czeka" / "odebrane") with "Cofnij".
- Recipient: a sheet "Tomek przekazał Ci ustawienia Trio dla: Zosia" (app start, return to the app, after confirming
  remote bolus; once per launch), and the same rows on the patient page and Zdalny bolus. "Zapisz": fetch once → check
  S → decrypt (Face ID for the bolus key) → check the plaintext → save into `TrioRemoteSettings` / `LoopRemoteSettings`
  in the Keychain exactly as if typed (limits reviewed, the owner's pinned Trio / Loop; refused when the secret or the
  loop belongs to another patient on this phone) → "Gotowe do wysyłania". A fetched package is kept in memory while
  Face ID is retried; quitting the app before saving loses it (the owner sends again). "Odrzuć" deletes it.
- Limits: the owner's are copied; the recipient can lower them in Zdalne sterowanie; never looser than the loop (Loop's
  `max_bolus_u` check as before; Trio's own limits always apply in Trio).

## 9. Live Activity for two patients (both auth modes; migration 094)

Owner decision 2026-10-29. Not device-auth specific: the same route serves Cognito and device mode.

`PUT /v1/patients/{patientId}/devices/{deviceId}/live-activity` (the 088 route) takes, besides `enabled`,
`island_enabled` and the tokens:

- `patient_ids: [uuid, uuid?]` — the patients shown, 1 or 2, the first one must be `{patientId}`, no repeats, each one the
  caller's (403 otherwise); the phone must be registered (active `patient_devices` row) for every one of them, else 404
  `Device not registered`. Left out: the same first patient keeps its list; another patient (an app from before 094)
  replaces the list with that one patient.
- `island_mode: "both" | "closer"` — two patients in the Dynamic Island: "Oboje" (compact leading = one patient's
  glucose and arrow, trailing = the other's, no IOB) or "Bliższe zagrożeniu" (the patient closer to danger, with IOB).
- `island_left_patient_id: uuid | null` — "Oboje": the patient on the left (null or unknown = the first).

The answer adds `patient_ids`, `island_mode`, `island_left_patient_id`. Columns: `patient_ids uuid[]` (check: 1-2,
`patient_ids[1] = patient_id`; old rows backfilled to their one patient), `island_mode`, `island_left_patient_id`,
`last_readings jsonb` ({ patient_id: newest reading pushed }).

**Who is shown.** Every tick the worker shows, in order, the patients the row lists for which the phone is still
registered and the person still has "Glukoza i alarmy" (owners always). A patient who drops out disappears from the
activity on the next push; if it was the first, the second is shown alone in the same activity (no restart: the content
carries `patientID` / `patientName`). Nobody left: the row is skipped.

**Content-state.** One patient: exactly the 088 keys. Two patients: the first patient's fields as before plus
`patientID`, `patientName`, `others: [{ id, name, glucose, direction, delta, readingAt, iob }]`, `islandMode`,
`islandLeft`; `readings` and `boluses` are empty (no chart in the two-patient layouts), so a push stays well under 1 KB
(ActivityKit allows 4 KB). Older apps ignore the new keys; the new app decodes old content (all new keys optional).
`stale-date` = 16 min after the newest reading of the patients shown (the home widgets' rule: dimmed once a reading is
over 15 whole minutes old; `LIVE_ACTIVITY_STALE_AFTER_SECONDS`). Push-to-start alert title: "Zosia i Kuba".

**When it pushes.** On a new reading of either patient. Two patients: at most one update a minute per phone
(`LIVE_ACTIVITY_TWO_PATIENT_MIN_INTERVAL_MS`), each carrying both newest readings; a reading within a minute of the last
push waits for the first tick after that minute (≤ ~75 s). Never held back: a glucose under 70 on either patient, the
first push after the phone changed patients / island mode / left side (the row's `last_readings` is cleared), a patient
dropping out, starts and ends. So two 5-minute sensors give at most two pushes per 5 minutes (one when they come close
together) and two 1-minute sensors one a minute, not two. One patient: unchanged (a push per reading).

**Stale nudge (2026-10-31).** iOS redraws an activity only on an update or, lazily and often minutes late, when its
`stale-date` passes, so the Live Activity dimmed ~5 min after the widgets (whose timeline redraws every minute). When a
shown patient's newest reading turns stale (16 min) and no newer one came, the worker sends one update with the same
content (priority 10, no alert) from 10 s after that mark (`LIVE_ACTIVITY_STALE_NUDGE_SLACK_MS`), on the first tick
(15 s). Due while the row's `last_push_at` is before the mark, so it goes once per reading and survives restarts; given
up 10 min after the mark (`LIVE_ACTIVITY_STALE_NUDGE_WINDOW_MS`). Two patients: one at each patient's own mark (the
one-a-minute rule applies). At most one extra push per gap in the readings.

**"Bliższe zagrożeniu"** (app side, `LiveDanger` in GlucoMindCore): each patient's glucose in 15 min is projected as
`glucose + 3 × delta` (delta per 5 min). Tiers: (1) low, current or projected < 70, lower first; (2) high, current or
projected > 250, higher first; (3) in range, smaller margin first, margin = min(projected − 70, (250 − projected) / 2);
(4) no reading for 15 min, last. A low always beats a high; a tie keeps the first patient. The minimal island (shared
with another app) always shows this patient.

## Stage 4 notes (iOS)

- Device mode in the app: no Cognito code paths; the pairing screen (scanner + paste link) is the first screen without
  a stored server + device id. After pairing store `server`, `device_id` (Keychain, shared with the widget).
- Session renewal: on 401 or 1 min before `expires_at`, challenge + sign with the device key (no Face ID).
- Patient switcher: `GET /v1/me/patients` lists every patient of the person; the confirmation always names the patient
  the command is for (from `signing-challenges.patient_name`).
- "Udostępnianie": people list, invite (QR of `pairing_url`, share sheet), permissions, revoke devices; "Dołącz" for
  an invitation code when already paired; "Ten telefon / Inne urządzenia" from `GET /v1/me/devices`.
- First owner device paired automatically by `install-app.sh` (stage 6): it can call `POST /v1/setup/owner` with the
  setup code and pass the `pairing_url` to the app at first launch.

## Not done here (follow-ups)

- Installations on Cognito keep working; moving one to device mode means its owners re-pair with `reset-owner`.
- The setup page itself (stage 5) — these endpoints are what it calls; it also writes `.env` (AI key, APNs key).
- No rate limiting on public routes (codes are 100-125 bits; setup code ≥ 16 characters); add one in the reverse proxy.
- Pause switch, self profiles, scheduled profile deletion and the other e-mail-era audit items were not ported.
