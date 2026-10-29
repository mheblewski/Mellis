# iOS + Push Foundation

## Scope

This foundation supports the first complete journey:

Nightscout -> hypo detection -> AI follow-up question -> conversation persisted -> push notification -> iOS opens -> conversation fetched -> answer submission.

## API Contract

### Register push device

Endpoint:

POST /v1/patients/{patientId}/devices

Request body:

{
  "platform": "ios",
  "device_id": "installation-uuid",
  "push_token": "apns-token-hex",
  "app_version": "0.1.0"
}

Response:

201 when created, 200 when updated.

{
  "device": {
    "id": "...",
    "patient_id": "...",
    "platform": "ios",
    "device_id": "...",
    "push_token": "...",
    "active": true
  }
}

### Conversation flow endpoints used by iOS

GET /v1/patients/{patientId}/conversations/{conversationId}
POST /v1/patients/{patientId}/conversations/{conversationId}/messages
GET /v1/patients/{patientId}/hypo-episodes
GET /v1/patients/{patientId}/hypo-episodes/{episodeId}

## Push Payload

Payload contains only minimal routing metadata:

{
  "aps": {
    "alert": {
      "title": "GlucoMind",
      "body": "Mam jedno pytanie dotyczace ostatniej hipoglikemii."
    },
    "sound": "default"
  },
  "gluco": {
    "type": "conversation_question",
    "patientId": "...",
    "conversationId": "..."
  }
}

No glucose history, insulin data, context package, or analysis detail is included in the push payload.

## Worker Integration

When a context question is persisted, worker enqueues an idempotent job:

job_type: notifications.push_conversation_question

dedupe key:

conversation-question:{patientId}:{conversationId}:{questionId}

Push delivery state is persisted in push_notifications.

## Universal Links

Expected route format:

https://app.mellis.invalid/patients/{patientId}/conversations/{conversationId}

The app parses this route and fetches conversation state from backend. Backend authorization remains authoritative.

## Local Development

Use fake transport for push while preserving architecture:

PUSH_PROVIDER=fake

This keeps app/backend flow testable without APNs credentials.

## Real APNs Configuration

Set these in environment (never commit private values):

PUSH_PROVIDER=apns
APNS_TEAM_ID=...
APNS_KEY_ID=...
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APNS_BUNDLE_ID=pl.glucomind.ios
APNS_USE_SANDBOX=true
APNS_TIMEOUT_MS=10000

Do not commit .p8 files.

## End-to-End Developer Test

1. Run migrations.
2. Run API and worker.
3. Register iOS device token via POST /devices.
4. Trigger synthetic workflow test command:

npm run test:first-hypo

5. Observe creation of notifications.push_conversation_question job and push_notifications record.
6. In iOS app, open by universal link or push payload route and fetch conversation.
