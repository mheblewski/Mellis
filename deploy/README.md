# Server deployment

A Mellis server is set up with the installer below; user docs: `docs-site/docs/instalacja/serwer.md`.

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

## Developer: build the image yourself

For a fork or development, instead of pulling a release image (`ghcr.io/mheblewski/mellis:<MELLIS_VERSION>`):

```sh
cd deploy
cp .env.production.example .env && chmod 600 .env      # fill every <...> (the installer normally writes it)
mkdir -p secrets data/ai data/photos backups
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build   # the migrate service runs first
```

The TypeScript build needs about 1.5 GB of RAM (add swap on a 2 GB server). The containers run as uid 1000
(`chown 1000:1000 secrets/apns.p8 data/ai data/photos`). Without the installer there is no `mellis` tool: back up
with `backup.sh` (its header has the cron line) and update by building the new tag. Device mode needs
`PUBLIC_BASE_URL`; the first phone pairs with `SETUP_CODE` through `scripts/install-app.sh` on a Mac.
