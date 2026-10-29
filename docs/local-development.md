# Local Development

This document describes the manual setup for the existing first vertical slice only. It does not add new product behavior.

## Prerequisites

- macOS with Xcode installed
- Node.js 20.x
- npm
- PostgreSQL 14+ running locally
- A physical iPhone with Developer Mode enabled
- Apple Developer account access for signing, Push Notifications, and Associated Domains

## Repository Layout

- `apps/api` - HTTP API runtime
- `apps/worker` - background worker runtime
- `apps/ios` - native SwiftUI iOS app package
- `infra/db` - database migrations
- `docs/` - operational notes and setup docs

## Environment File

Copy [`.env.example`](../.env.example) to your local `.env` or export the same variables in your shell.

If you want a guided setup, run:

```bash
npm run setup:iphone
```

The wizard resumes from existing local `.env` and `apps/ios/.env.local` values when present, asks only for missing values, writes the backend `.env`, writes `apps/ios/.env.local`, primes the macOS GUI environment for Xcode, and opens `apps/ios` in Xcode.

It also asks for the Apple Team ID, iOS bundle identifier, and APNs settings so the same local setup can be reused for push-capable device builds.

Never commit real secrets, `.p8` files, bearer tokens, or API keys.

Key variables:

- `DATABASE_URL`
- `TEST_DATABASE_URL` (required for `RUN_POSTGRES_INTEGRATION=1`; must point to an isolated test database)
- `API_PORT`
- `API_HOST` (optional; unset listens on every interface, which a physical iPhone on the LAN needs; `127.0.0.1` keeps the API local-only)
- `NIGHTSCOUT_BASE_URL`
- `NIGHTSCOUT_API_TOKEN`
- `NIGHTSCOUT_AUTH_MODE` (`BEARER` or `API_SECRET_SHA1`, default `BEARER`)
- `NIGHTSCOUT_PATIENT_ID`
- `NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES` (positive integer, default `24`)
- `NIGHTSCOUT_SYNC_LOOKBACK_MINUTES` (non-negative integer, default `360`; each sync re-reads entries and treatments this far behind its cursors for late uploads, `0` turns it off)
- `AI_PROVIDER` (`fake`, `openai` or `anthropic`)
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TIMEOUT_MS`
- `PUSH_PROVIDER` (`fake` or `apns`)
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY_PATH` or `APNS_PRIVATE_KEY`
- `APNS_BUNDLE_ID`
- `APNS_USE_SANDBOX`
- `APNS_TIMEOUT_MS`
- `API_BASE_URL` or `GLUCOMIND_API_BASE_URL`
- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`
- `COGNITO_TOKEN_USE` (`access` or `id`)
- `GLUCOMIND_BOOTSTRAP_CONVERSATION_ID` optional
- legacy local dev overrides remain only for temporary app bootstrap and should not be used in production auth flow

## PostgreSQL Setup

Create the database and run migrations:

```bash
createdb gluco_mind
npm run migrate
```

If your PostgreSQL user differs, set `DATABASE_URL` accordingly before running migrations.

### PostgreSQL Integration Test Isolation

Integration tests are fail-closed by design and require an explicit isolated test database.

Example:

```bash
createdb gluco_mind_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gluco_mind_test DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gluco_mind_test npm run migrate
RUN_POSTGRES_INTEGRATION=1 TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gluco_mind_test npx vitest run --reporter=basic
```

Behavior:

- when `RUN_POSTGRES_INTEGRATION=1`, test runtime requires `TEST_DATABASE_URL`
- test runtime rewires `DATABASE_URL` to `TEST_DATABASE_URL`
- destructive test resets validate connected database identity (`database`, `host`, `port`) before `TRUNCATE`
- if the connected database does not match the configured test identity, tests fail and do not truncate

## Backend Startup

Start the API and worker in separate terminals:

```bash
npm run dev:api
npm run dev:worker
```

Recommended development defaults:

- `AI_PROVIDER=fake` for normal local development
- `PUSH_PROVIDER=fake` for normal local development
- `AI_PROVIDER=openai` (or `anthropic` for Claude) only when you explicitly want real paid execution
- `PUSH_PROVIDER=apns` only when you want real device push delivery

## Worker Startup Requirements

The worker requires these values at minimum:

- `DATABASE_URL`
- `NIGHTSCOUT_BASE_URL`
- `NIGHTSCOUT_API_TOKEN`
- `NIGHTSCOUT_AUTH_MODE`
- `NIGHTSCOUT_PATIENT_ID`
- `NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES`
- `AI_PROVIDER`
- `PUSH_PROVIDER`

When `AI_PROVIDER=openai`, also set `OPENAI_API_KEY`.
When `AI_PROVIDER=anthropic`, set `ANTHROPIC_API_KEY` and `ANTHROPIC_PRICING_*` instead (same cost guard and ledger as
OpenAI). Claude answers conversations, analyses, meal estimates, meal chat and WBT; knowledge-search embeddings and voice
transcription keep using `OPENAI_API_KEY`. Switching back is `AI_PROVIDER=openai` and a worker restart.
When `PUSH_PROVIDER=apns`, also set APNs credentials.

Nightscout authentication mode:

- `NIGHTSCOUT_AUTH_MODE=BEARER` (default):
`NIGHTSCOUT_API_TOKEN` is sent as `Authorization: Bearer <token>`.
- `NIGHTSCOUT_AUTH_MODE=API_SECRET_SHA1`:
`NIGHTSCOUT_API_TOKEN` is treated as the raw Nightscout API secret and sent as `api-secret: SHA1(secret)`.

## iOS Startup

The iOS app is defined in [`apps/ios/Package.swift`](../apps/ios/Package.swift).
Open `apps/ios` in Xcode 16+ and run the package target on a physical iPhone.

For local app runtime configuration, set:

- `API_BASE_URL` or `GLUCOMIND_API_BASE_URL` to the Mac LAN IP, not `localhost`
- `AUTH_MODE` (`cognito` or `disabled`, default `cognito`)
- `ALLOW_AUTH_DISABLED_IN_LOCAL` (`true/false` or `1/0`, required when `AUTH_MODE=disabled`)

Local no-login MVP mode:

- set `AUTH_MODE=disabled`
- set `ALLOW_AUTH_DISABLED_IN_LOCAL=true`
- use a Debug local build configuration only

Fail-closed behavior:

- disabled auth mode is blocked for non-debug builds
- disabled auth mode is blocked unless `ALLOW_AUTH_DISABLED_IN_LOCAL=true`

Local shared-token mode (`AUTH_MODE=local_token`, for testing a physical iPhone over Wi-Fi without exposing an
unauthenticated API):

- generate a random token locally, for example `openssl rand -base64 32`; never commit it
- backend: `AUTH_MODE=local_token`, `NODE_ENV=development`, `LOCAL_AUTH_USER_ID=<user UUID>`,
  `LOCAL_AUTH_TOKEN_SHA256=<hex SHA-256 of the token>` (for example `printf %s "$TOKEN" | shasum -a 256`), and
  `ALLOW_AUTH_DISABLED_IN_LOCAL` unset or `false`; anything missing or malformed refuses to start
- every request needs `Authorization: Bearer <token>`; a missing or wrong token is HTTP 401
- iOS (Debug only): `AUTH_MODE = local_token`, `ALLOW_AUTH_DISABLED_IN_LOCAL = 0` and `LOCAL_AUTH_TOKEN = <token>` in
  `apps/ios/Config.local.xcconfig`; Release builds reject the mode and never embed the token
- the token is a development secret compiled into the Debug app bundle: anyone with the bundle can read it; rotate it
  if a build leaves your devices, and never distribute such builds
- `COGNITO_DOMAIN_URL` to your Cognito hosted UI domain URL
- `COGNITO_CLIENT_ID` to your Cognito app client ID
- `COGNITO_REDIRECT_URI` to the iOS redirect URI registered in Cognito
- `COGNITO_SCOPES` to at least `openid profile email`

Example:

```bash
API_BASE_URL=http://192.168.1.10:3000
COGNITO_DOMAIN_URL=https://your-domain.auth.eu-central-1.amazoncognito.com
COGNITO_CLIENT_ID=your-client-id
COGNITO_REDIRECT_URI=pl.glucomind.ios://auth/callback
COGNITO_SCOPES=openid profile email
```

## Physical iPhone Requirements

- Sign the app with your Apple Developer team
- Use the bundle identifier `pl.glucomind.ios`
- Enable the Push Notifications capability
- Enable the Associated Domains capability
- Trust the Mac on the device if prompted
- Enable Developer Mode on the iPhone if prompted by iOS

The setup wizard collects the team and bundle values, but the Push Notifications and Associated Domains checkboxes still need to be enabled in Xcode for the app target.

If Xcode asks for provisioning updates, accept them in your Apple Developer account and re-run the app.

## APNs Configuration

Use the current Apple server-to-server APNs authentication flow.

What the developer needs:

- Apple Developer account with APNs enabled for the app ID
- APNs Auth Key downloaded from Apple Developer portal
- Key ID from the APNs Auth Key
- Team ID from the Apple Developer account
- `.p8` file stored locally outside the repository

Recommended local layout:

```text
~/Library/Application Support/GlucoMind/APNs/AuthKey_XXXXXX.p8
```

The runtime can read either:

- `APNS_PRIVATE_KEY` with the file contents in the environment, or
- `APNS_PRIVATE_KEY_PATH` pointing to the local `.p8` file

Example APNs development configuration:

```bash
PUSH_PROVIDER=apns
APNS_TEAM_ID=YOUR_TEAM_ID
APNS_KEY_ID=YOUR_KEY_ID
APNS_PRIVATE_KEY_PATH=/Users/you/Library/Application Support/GlucoMind/APNs/AuthKey_XXXXXX.p8
APNS_BUNDLE_ID=pl.glucomind.ios
APNS_USE_SANDBOX=true
```

How to verify APNs configuration safely:

- confirm the worker starts with `PUSH_PROVIDER=apns`
- confirm a push job moves to `sent` or retry state in the database
- confirm the APNs provider tests remain green
- never print the private key, bearer token, or authorization headers

## Universal Links

Implemented in the app:

- route parsing for `https://app.mellis.invalid/patients/{patientId}/conversations/{conversationId}` (`AppLink.origin`)
- navigation to the matching conversation
- push payload routing to the same conversation

Requires hosting/configuration:

- `apple-app-site-association` must be hosted for the real domain
- Associated Domains entitlement must be configured in the signed iOS app
- the app ID must match the bundle identifier and team

Development-safe approach:

- verify navigation using the push notification route payload
- use the same patient and conversation IDs as the backend returns
- do not assume the production universal-link domain works until Apple/domain configuration is deployed

## Synthetic Hypo Trigger

Use the existing deterministic first-slice workflow:

```bash
npm run dev:trigger-hypo
```

The command above is in-memory test validation only. It does not persist a conversation in PostgreSQL.

To create a real PostgreSQL-backed synthetic first slice for physical iPhone bootstrap, use:

```bash
npm run dev:seed-first-slice
```

This command is development-only and performs:

- synthetic Nightscout ingestion through existing service boundaries
- existing hypo detection and AI workflow through worker job processing
- persistence to real PostgreSQL tables
- API verification using `GET /v1/patients/{patientId}/conversations/{conversationId}`

To remove synthetic records created by this tooling:

```bash
npm run dev:reset-first-slice
```

To run the integration test against PostgreSQL explicitly:

```bash
npm run test:dev-seed-first-slice
```

This reuses the synthetic Nightscout fixture and the existing Nightscout ingestion, hypo detection, AI, conversation, and push workflow.

If you want the deterministic end-to-end verification, run:

```bash
npm run e2e:first-slice
```

## Real OpenAI

Normal development stays offline by default.

Use real OpenAI only when explicitly requested:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-terra
OPENAI_TIMEOUT_MS=15000
OPENAI_PRICING_INPUT_PER_1K_TOKENS=...
OPENAI_PRICING_OUTPUT_PER_1K_TOKENS=...
OPENAI_PRICING_CACHED_INPUT_PER_1K_TOKENS=...
OPENAI_PRICING_REASONING_PER_1K_TOKENS=...
OPENAI_PRICING_CURRENCY=USD
OPENAI_PRICING_VERSION=...
```

When `AI_PROVIDER=openai`, pricing variables are required so successful executions persist KNOWN cost on both attempt and execution rows.

The deterministic tests and the normal first-slice flow do not require an OpenAI key.

## Fake Push vs APNs

Development mode:

- `PUSH_PROVIDER=fake`
- push delivery is recorded through the fake provider
- useful for tests and local backend work

Real device mode:

- `PUSH_PROVIDER=apns`
- APNs sends notifications to the physical iPhone
- do not replace APNs with fake push for the real-device verification

## Log Inspection

Inspect logs in the terminal where the process is running.

Safe log guidelines:

- never paste secrets into logs
- do not enable verbose tracing that prints bearer tokens or APNs headers
- keep API and worker terminals separate
- if you redirect logs to a file, store it locally and avoid committing it

Useful signals to watch:

- Nightscout sync start/completion
- job claim/success/failure
- AI execution success/failure
- push job delivery status
- API 404s for unauthorized patients

## Resetting the Synthetic Scenario

To reset local verification:

1. Stop API, worker, and Xcode.
2. Drop and recreate the database, then rerun migrations.
3. Re-run `npm run dev:trigger-hypo` or `npm run e2e:first-slice`.
4. Reinstall the app on the iPhone if bundle signing or token registration changed.

## Manual Verification Checklist

- [ ] backend starts
- [ ] worker starts
- [ ] PostgreSQL starts
- [ ] iPhone app builds
- [ ] app installs on physical iPhone
- [ ] app reaches backend
- [ ] APNs permission appears
- [ ] device registers
- [ ] device appears in backend
- [ ] synthetic hypo created
- [ ] hypo episode created
- [ ] AI question created
- [ ] push job created
- [ ] APNs notification delivered
- [ ] notification opens app
- [ ] correct conversation opens
- [ ] question displayed
- [ ] answer submitted
- [ ] follow-up job created
- [ ] analysis completes
- [ ] recommendation displayed

## Troubleshooting

### iPhone cannot reach backend

- Use the Mac LAN IP in `API_BASE_URL` or `GLUCOMIND_API_BASE_URL`, not `localhost`
- Confirm the API listens on the configured `API_PORT`
- Check that the Mac and iPhone are on the same network
- Ensure the macOS firewall allows inbound connections for the API process

### APNs token not registered

- Confirm Push Notifications capability is enabled
- Confirm the app launched on a physical device, not only a simulator
- Confirm the device token registration request hits `POST /v1/patients/{patientId}/devices`

### Notification permission denied

- Re-enable notifications in iPhone Settings for the app
- Remove and reinstall the app if you need to repeat first-launch permission flow

### APNs authentication failure

- Check `APNS_TEAM_ID`
- Check `APNS_KEY_ID`
- Check `APNS_PRIVATE_KEY_PATH` or `APNS_PRIVATE_KEY`
- Confirm the `.p8` file matches the key ID

### Notification not delivered

- Confirm `PUSH_PROVIDER=apns` in the worker
- Confirm the device token is active in the database
- Confirm the push job reaches a terminal success or retry state
- Confirm the app is signed with the same bundle identifier as `APNS_BUNDLE_ID`

### Notification delivered but conversation does not open

- Confirm the payload contains only the minimal `gluco` routing keys
- Confirm the conversation exists in the backend
- Confirm the backend returns the conversation for the patient
- Confirm the universal-link parser route matches the payload route

### Universal Link does not open the app

- Confirm Associated Domains is enabled
- Confirm the `apple-app-site-association` file is hosted for the real domain
- Confirm the bundle identifier and Team ID match the entitlement

### OpenAI key missing

- Set `OPENAI_API_KEY` only for explicit OpenAI runs
- Do not set it for normal fake-provider development if you do not need real model execution

### OpenAI request fails

- Confirm the worker is using `AI_PROVIDER=openai`
- Confirm model and timeout values are valid
- Check provider error mapping in the worker logs without printing the raw key

### Worker not processing jobs

- Confirm `DATABASE_URL` is correct
- Confirm the worker process is running
- Confirm jobs are queued and not stuck in failed state
- Confirm the job lease is not expired or permanently locked

## Security Checks

- [x] secrets are gitignored
- [x] `.p8` files are gitignored
- [x] API keys are not logged
- [x] bearer tokens are not logged
- [x] APNs credentials are not logged
- [x] push payload contains minimal data
- [x] development-only HTTP configuration is isolated to local development
