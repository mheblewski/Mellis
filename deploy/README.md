# Server deployment

> Self-hosted community servers use the installer below. The manual flow after it (sections 1-9) is the older
> generic-VPS Cognito setup (one account per caregiver), kept for reference.

## Self-hosted Mellis: `scripts/install-server.sh` and `mellis`

On the server (Ubuntu 24.04 / Debian 12, root or sudo), as in `docs-site/docs/instalacja/serwer.md`:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.0/scripts/install-server.sh)"
```

What it does, resumable (a rerun continues; `state/install.state` remembers the answered steps):

1. Checks: RAM (900 MB, 1.8 GB with a Nightscout container or port 1337 on the host), 3 GB disk, OS, CPU, public IPv4
   / Mikrus. Docker CE + compose plugin from Docker's apt repository on request; `jq`, `qrencode`, `openssl` via apt.
2. `/opt/mellis` (compose project `mellis`): `docker-compose.yml`, `Caddyfile` and the tool itself copied from the
   pinned image's `/app/server-kit` (`MELLIS_DEFAULT_VERSION`, kept equal to package.json by
   `scripts/sync-version.sh`); `.env` chmod 600 with generated `POSTGRES_PASSWORD`, `SETUP_CODE`,
   `NIGHTSCOUT_TOKEN_ENCRYPTION_KEY`, `AUTH_MODE=device`, `REMOTE_COMMANDS_ENABLED=true`, the feature switches, prices
   and per-call limits of the chosen provider; `secrets/apns.p8`; `data/ai` (ledger), `data/photos`.
3. "Nowa instalacja" or "Przywróć z kopii" (a `mellis-*.tar.gz` of this tool, or a plain `pg_dump -Fc` of an older
   installation such as `backup.sh` makes; restored before the migrations run).
4. With postgres, migrate and the API up (AI fake): Nightscout (`POST /v1/setup/nightscout-check`), patients
   (`POST /v1/setup/patients`); after a restore the patients' tokens via `mellis-admin set-nightscout`. AI key(s)
   (`POST /v1/setup/ai` while the setup is open, `mellis-admin check-ai` otherwise), monthly limit
   (`mellis-admin ai-limit`), APNs (`APNS_BUNDLE_ID=pl.mellis.<TeamID>`, sandbox), address: own domain
   (`COMPOSE_PROFILES=caddy`), Mikrus subdomain (`API_PUBLISH=<port>` on every interface, the port shown for the
   panel, waits until `https://<subdomain>/v1/app-config` answers) or Cloudflare Tunnel (`COMPOSE_PROFILES=tunnel`,
   `CLOUDFLARE_TUNNEL_TOKEN`; public hostname → `http://api:3000` in Cloudflare).
5. After the AI ledger: `mellis-admin knowledge-build` indexes the knowledge base shipped in the image
   (`/app/knowledge`, infra/db/knowledge-build.ts): full text (BM25) only without `OPENAI_API_KEY`, with it also
   `text-embedding-3-small` vectors through the cost guard and the ledger; rebuilt only when the corpus hash or the
   mode changes; never replaces a corpus it did not build (production's own index). On success
   `AI_ENABLE_KNOWLEDGE_SEARCH=1`; a failure leaves it 0 and the installation goes on.
6. Starts everything, checks the version and the worker, first backup, `/usr/local/bin/mellis`, `/etc/cron.d/mellis`
   (backup 03:00, update check 04:30). The summary prints the address, the **Kod konfiguracji** (= `SETUP_CODE`) and
   the `install-app.sh -- --server … --code …` command. The first owner and the recovery code are made by
   `install-app.sh` on the Mac (`POST /v1/setup/owner`): the server installer never calls that route.

`mellis` (menu, or `mellis <command>`): `status`, `logs`, `report` (no keys, no medical data, no names, no address:
versions, container states, counts, log event names and error codes), `update [X.Y.Z]` (backup → kit + image →
migrate → health check → `knowledge-build` when the shipped corpus changed → on failure the previous kit, image and the
database from that backup), `knowledge` (the knowledge build by hand), `backup`, `download`
(the `scp` line for the Mac), `restore [file]`, `settings` (Nightscout, AI key, AI limit, address, APNs, version:
older versions only with a backup made on that version), `pair-owner` (`mellis-admin owners`; with several owners
"Kogo połączyć?" by name and last activity, then `reset-owner --user <id>`; terminal QR), `recover-owner` (the same plus
an optional new recovery code for that owner, `recovery-code --user <id>`), `uninstall` (keep data in `/opt/mellis-kopia` or
remove everything: only the `mellis` compose project with its volumes, `/opt/mellis`, the command and the cron file),
`setup-code`, `check-update`.

Backups: `/opt/mellis/backups/mellis-<version>-<date>[-label].tar.gz` = `database.dump` (`pg_dump -Fc`), `photos/`,
`ai/` (ledger), `settings.env` (without keys, tokens and passwords), `manifest.txt`; 14 days kept. A restore on another
server (different `MELLIS_SERVER_ID`) asks for the patients' Nightscout tokens again (they are encrypted with the old
server's key).

Tests: `bash scripts/tests/install-server.test.sh` (stubbed docker/curl, no root, also run by vitest).

## Manual Cognito deployment (reference)

Target: caregivers with Cognito accounts sharing one patient, on one small VPS (x86, 2 vCPU, 2 GB RAM, 60 GB)
running Docker Compose:
`postgres`, `migrate` (one-shot), `api`, `worker`, `caddy` (profile `caddy`: public HTTPS, Let's Encrypt). The app
runs the released image `ghcr.io/mheblewski/mellis:<MELLIS_VERSION>` (built by `.github/workflows/release-image.yml` on
a tag vX.Y.Z); nothing is compiled on the server. Every command below runs on the server in `/opt/gluco-mind/deploy`
unless marked **Mac**.

Building the image on the server instead (a fork, development): add `-f docker-compose.yml -f docker-compose.build.yml`
to every `docker compose` command and `--build` to `up`; that override also defines the `tools` service used in
sections 4 and 5 (the released image has no tsx or scripts).

## 1. Accounts and DNS (once, by hand)

- **netcup:** order VPS nano G11s with IPv4 (12-month minimum term). In the Server Control Panel (SCP) reinstall it
  with Ubuntu 24.04 and your SSH public key; note the IPv4 address. Any other VPS with ≥ 2 GB RAM, ~20 GB disk and a
  public IPv4 works the same way (Hetzner, OVH, ...).
- **DNS:** an A record (and AAAA) for the API host name pointing at the server IP (own domain or a free DuckDNS name).
- **Cognito** (eu-central-1): user pool with self sign-up disabled; app client without a client secret; managed login
  (Hosted UI) domain; callback URL `<scheme>://auth/callback` (the iOS `COGNITO_REDIRECT_URI`); scopes
  `openid profile email`. Create the two users in the console.
- **Apple:** APNs auth key (`.p8`) and App Store Connect access for TestFlight (section 7).

## 2. Server preparation

```sh
apt update && apt -y upgrade
apt -y install docker.io docker-compose-v2 unattended-upgrades ufw
dpkg-reconfigure -plow unattended-upgrades

# Firewall on the host (netcup has no cloud firewall). Docker publishes only 80/443 (caddy); postgres and the API
# are reachable only inside the compose network.
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable

# SSH: keys only
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl reload ssh

# 2 GB swap: only needed when building the image here (docker-compose.build.yml: npm ci + tsc on 2 GB RAM)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-swappiness.conf && sysctl --system >/dev/null

mkdir -p /opt/gluco-mind
```

## 3. Code and configuration

**Mac** (ships the committed tree; no Git credentials on the server):

```sh
git archive HEAD | ssh root@<server> 'tar -x -C /opt/gluco-mind && mkdir -p /opt/gluco-mind/deploy/secrets'
scp ~/path/to/AuthKey_XXXX.p8 root@<server>:/opt/gluco-mind/deploy/secrets/apns.p8
```

Server:

```sh
cd /opt/gluco-mind/deploy
mkdir -p secrets data/ai backups
cp .env.production.example .env && chmod 600 .env    # fill every <...>; POSTGRES_PASSWORD: openssl rand -hex 32
chown 1000:1000 secrets/apns.p8 data/ai && chmod 400 secrets/apns.p8   # containers run as uid 1000 (node)
docker compose pull
docker compose up -d postgres
```

## 4. Database

Option A, **keep the current history** (recommended). **Mac:**

```sh
pg_dump -Fc -d <local database> > glucomind.dump
scp glucomind.dump root@<server>:/opt/gluco-mind/deploy/backups/
```

Server (restore into the empty database first, then migrate):

```sh
docker compose exec -T postgres pg_restore -U glucomind -d glucomind --no-owner --no-privileges < backups/glucomind.dump
docker compose run --rm migrate
```

Option B, **fresh start:**

```sh
docker compose run --rm migrate
docker compose exec -T postgres psql -U glucomind -d glucomind -v ON_ERROR_STOP=1 \
  -v patient_id=<NIGHTSCOUT_PATIENT_ID> -v name='<display name>' < sql/bootstrap-patient.sql
# optional: import the last 30 days as HISTORICAL (no conversations, no AI)
docker compose -f docker-compose.yml -f docker-compose.build.yml run --rm tools npx tsx --tsconfig tsconfig.json scripts/nightscout-sync-once.ts ensure-source
docker compose -f docker-compose.yml -f docker-compose.build.yml run --rm tools npx tsx --tsconfig tsconfig.json scripts/nightscout-sync-once.ts window <from-iso> <to-iso>
```

## 5. AI budget ledger

Paid calls stop when the ledger's total budget or call count is reached. One ledger per budget period:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml run --rm tools npx tsx --tsconfig tsconfig.json scripts/evaluation/init-ai-experiment-budget-ledger.ts \
  --path /data/ai/ai-usage-ledger-2026-10.json --experiment-id production-2026-10 \
  --total-budget 15 --currency USD --max-calls 1500
```

The file name must match `AI_LEDGER_FILE` in `.env`. Next period: create a new file, update `AI_LEDGER_FILE`, run
`docker compose up -d`.

## 6. Start and check

```sh
docker compose --profile caddy up -d
docker compose ps                         # api healthy, worker running, migrate exited 0
docker compose logs -f worker api         # worker_mode ALL_JOB_TYPES, nightscout_sync ENABLED
curl -i https://<DOMAIN>/v1/me/patients   # 401 Missing bearer token = TLS + API OK
curl -s https://<DOMAIN>/v1/app-config     # server.version = MELLIS_VERSION
```

## 7. iOS build (TestFlight, both phones)

`apps/ios/Config.local.xcconfig`:

```
API_BASE_URL = https:$(XC_SLASH)$(XC_SLASH)<DOMAIN>
AUTH_MODE = cognito
ALLOW_AUTH_DISABLED_IN_LOCAL = 0
COGNITO_DOMAIN_URL = https:$(XC_SLASH)$(XC_SLASH)<cognito hosted UI domain>
COGNITO_CLIENT_ID = <app client id>
COGNITO_REDIRECT_URI = <scheme>:$(XC_SLASH)$(XC_SLASH)auth/callback
```

Xcode: Product → Archive → Distribute → App Store Connect (export switches `aps-environment` to production, matching
`APNS_USE_SANDBOX=false`). In App Store Connect add the second caregiver as a user and both of you as internal
TestFlight testers. TestFlight builds expire after 90 days: upload a new build before that.

## 8. Link both caregivers to the patient

Each caregiver signs in once in the app (the screen stays empty: no patient yet). Then:

```sh
docker compose exec -T postgres psql -U glucomind -d glucomind < sql/list-identities.sql
docker compose exec -T postgres psql -U glucomind -d glucomind -v ON_ERROR_STOP=1 \
  -v patient_id=<NIGHTSCOUT_PATIENT_ID> -v login=<email or username from the list> < sql/link-caregiver.sql
```

Repeat for the second caregiver, then reopen the app. Pushes go to every active device of the patient.

## 9. Operations

- **Backups:** `crontab -e` → `15 3 * * * /opt/gluco-mind/deploy/backup.sh >> /opt/gluco-mind/deploy/backups/backup.log 2>&1`.
  Copy them off the server regularly (**Mac:** `rsync -av root@<server>:/opt/gluco-mind/deploy/backups/ ~/glucomind-backups/vps/`).
  Restore test: `pg_restore --list backups/<file>.dump`.
- **Update:** back up first (`./backup.sh`), set the new `MELLIS_VERSION` in `.env`, then `docker compose pull &&
  docker compose --profile caddy up -d` (migrate runs before api/worker start). Migrations only go forward: going back
  to an older version means restoring the backup taken before the update.
- **Logs:** `docker compose logs --since 1h worker`. Logs rotate at 5 × 10 MB per container.
- **Stop paid AI immediately:** set `AI_PROVIDER=fake` in `.env`, `docker compose up -d`.
- **Suspicious "no data" answers (daily review):** the worker flags an AI answer that says data is missing ("nie mam
  danych", "brak odczytów", "nie było bolusa", ...) while the database has that data in the answer's window
  (`metadata.anomaly_flags`, log event `suspicious_no_data_answer`). The answer itself is never changed. List the last
  N days (read-only, default 1):
  `docker compose exec -T postgres psql -U glucomind -d glucomind -v days=7 -f - < sql/suspicious-answers.sql`.
  A row is a candidate, not a proven bug: the claim may be about a narrower time than the window ("nie było bolusa o
  12"). Open the conversation by its question and compare with Nightscout; no rows is the expected state.
- **Server corrections of AI answers** (server-corrections.v1): every time the server changes what the model wrote (a
  note after a claim that insulin was given or a meal saved, a dose without a card, a free-text dose from a missing,
  low, falling or old reading, options dropped, a WBT dose bounded), the answer gets a `SERVER_CORRECTION` entry in
  `metadata.anomaly_flags` (log event `server_correction`) and a WBT suggestion a `server_adjustment`. Count and list
  them (read-only, default 7 days): `docker compose exec -T postgres psql -U glucomind -d glucomind -v days=7 -f - < sql/server-corrections.sql`.
  A kind that fires often means the prompt or a tool should change, not that another note is needed.
