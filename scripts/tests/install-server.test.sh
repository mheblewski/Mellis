#!/usr/bin/env bash
# Offline tests of scripts/install-server.sh (the installer and the `mellis` tool): docker, curl, apt-get and the
# server's own commands are stubs, the installation goes to a temporary directory, answers come on stdin. No network,
# no Docker, no root. Run: bash scripts/tests/install-server.test.sh
# shellcheck disable=SC2016,SC2012 # stub sources in single quotes; ls on our own file names
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO/scripts/install-server.sh"
# The release under test (package.json), so the checks follow a version bump.
export CUR; CUR="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO/package.json" | head -n 1)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mellis-install-test.XXXXXX")"
if [ -n "${KEEP_WORK:-}" ]; then echo "work: $WORK"; else trap 'rm -rf "$WORK"' EXIT; fi
PASSED=0
FAILED=0

fail() { printf 'FAIL: %s\n' "$*"; FAILED=$((FAILED + 1)); }
pass() { PASSED=$((PASSED + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass; else fail "$name"; fi; }
contains() { grep -qF -- "$2" "$1"; }
not_contains() { ! grep -qF -- "$2" "$1"; }

# --------------------------------------------------------------------------------------------------------------------
# Stubs
# --------------------------------------------------------------------------------------------------------------------

STUBS="$WORK/stubs"
mkdir -p "$STUBS"

cat > "$STUBS/docker" <<'STUB'
#!/usr/bin/env bash
# docker stub: logs every call, answers the compose project and the server CLI from $STUB_DIR.
printf 'docker %s\n' "$*" >> "$STUB_DIR/docker.log"
env_value() { sed -n "s/^$1=//p" "$MELLIS_ROOT/.env" 2>/dev/null | tail -n 1; }
case "$1" in
  --version) echo "Docker version 27.0.0, build test"; exit 0 ;;
  ps) exit 0 ;;
  inspect)
    cid="${!#}"
    case "$cid" in
      cid-migrate) echo "exited 0" ;;
      cid-worker) if [ "${STUB_WORKER_DOWN_VERSION:-}" = "$(env_value MELLIS_VERSION)" ]; then echo "restarting"; else echo "running"; fi ;;
      *) echo "running (kod 0, restartów 0, od 2026-10-29T03:00:00Z)" ;;
    esac
    exit 0 ;;
  image|pull|create|cp|rm) exit 0 ;;
  compose) shift ;;
  *) exit 0 ;;
esac
# docker compose ...
if [ "${1:-}" = "version" ]; then echo "Docker Compose version v2.29.0"; exit 0; fi
if [ "${1:-}" = "--help" ]; then
  if [ -n "${STUB_COMPOSE_OLD:-}" ]; then echo "      --progress string   Set type of progress output (auto, tty, plain)"; else echo "      --progress string   Set type of progress output (auto, tty, plain, json, quiet)"; fi
  exit 0
fi
progress=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-name|--project-directory|-f|--env-file) shift 2 ;;
    --progress) progress="$2"; shift 2 ;;
    *) break ;;
  esac
done
sub="${1:-}"; shift || true
# Like the real docker: a command that may read stdin eats what was piped into the installer (unless </dev/null).
case "$sub" in exec) case " $* " in *" pg_restore "*) ;; *) cat > /dev/null ;; esac ;; *) cat > /dev/null ;; esac
# Progress lines on stderr unless --progress quiet, as compose prints them.
case "$sub" in up|stop|run|down) [ "$progress" = quiet ] || echo "[+] Running 2/3 ⠿ Container mellis-api-1  Started" >&2 ;; esac
case "$sub" in
  up|stop|down|logs|pull)
    if [ "$sub" = "logs" ]; then
      echo 'api-1 | {"level":"info","event":"nightscout_sync_ok","patient":"Kuba","url":"https://ns.secret-host.example","glucose":142}'
      echo 'worker-1 | {"level":"error","event":"push_failed","code":"APNS_BAD_DEVICE_TOKEN","token":"abcdef"}'
    fi
    if [ "$sub" = "pull" ] && [ "${STUB_PULL_FAIL_VERSION:-}" = "$(env_value MELLIS_VERSION)" ]; then exit 1; fi
    exit 0 ;;
  ps)
    if [ "${1:-}" = "-aq" ]; then echo "cid-$2"; fi
    exit 0 ;;
  exec)
    [ "${1:-}" = "-T" ] && shift
    shift # service
    case "$1" in
      pg_isready) exit 0 ;;
      pg_dump) printf 'PGDMP fake dump\n'; exit 0 ;;
      psql) echo "psql $*" >> "$STUB_DIR/postgres.log"; exit 0 ;;
      pg_restore) cat > "$STUB_DIR/restored.dump"; echo "pg_restore $*" >> "$STUB_DIR/postgres.log"; exit 0 ;;
    esac
    exit 0 ;;
  run)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --rm|--no-deps|-T) shift ;;
        -e) shift 2 ;;
        *) break ;;
      esac
    done
    service="$1"; shift
    [ "$service" = "migrate" ] && { echo migrate >> "$STUB_DIR/postgres.log"; exit 0; }
    shift 2 # node dist/.../mellis-admin.js
    command="$1"; shift
    echo "admin $command $*" >> "$STUB_DIR/admin.log"
    case "$command" in
      check-ai)
        if [ "$AI_PROVIDER" = "openai" ]; then main="$OPENAI_API_KEY"; name=OPENAI_API_KEY; else main="$ANTHROPIC_API_KEY"; name=ANTHROPIC_API_KEY; fi
        case "$main" in *good*) ;; *) echo "{\"ok\":false,\"error\":\"AI_KEY_INVALID: $name\"}"; exit 1 ;; esac
        if [ "$AI_PROVIDER" = "anthropic" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
          case "$OPENAI_API_KEY" in *good*) ;; *) echo '{"ok":false,"error":"AI_KEY_INVALID: OPENAI_API_KEY"}'; exit 1 ;; esac
        fi
        echo '{"ok":true,"checked":["key"]}' ;;
      ai-limit) echo "$2" > "$STUB_DIR/ledger_total"; echo "{\"period\":\"MONTHLY\",\"total_budget\":$2,\"charged\":0,\"calls\":0,\"currency\":\"USD\",\"limit_reached\":false,\"resets_at\":\"2026-10-31T23:00:00.000Z\"}" ;;
      ai-status) echo "{\"period\":\"MONTHLY\",\"total_budget\":$(cat "$STUB_DIR/ledger_total" 2>/dev/null || echo 15),\"charged\":1.5,\"calls\":40,\"currency\":\"USD\",\"limit_reached\":false,\"resets_at\":\"2026-10-31T23:00:00.000Z\"}" ;;
      setup-status) echo "{\"auth_mode\":\"device\",\"setup\":\"$(cat "$STUB_DIR/setup_state" 2>/dev/null || echo OPEN)\",\"has_recovery_code\":$(cat "$STUB_DIR/has_recovery" 2>/dev/null || echo false),\"patients\":1,\"owners\":$(jq length "$STUB_DIR/owners.json" 2>/dev/null || echo 1),\"devices\":0}" ;;
      owners) printf '{"owners":%s}\n' "$(jq -c . "$STUB_DIR/owners.json" 2>/dev/null || echo '[{"user_id":"u1","display_name":"Ania","created_at":"2026-10-01T10:00:00.000Z","devices":1,"auth_identities":0,"has_login_history":true,"last_active_at":"2026-10-29T11:00:00.000Z","recovery_person":true}]')" ;;
      patients) printf '{"patients":%s}\n' "$(cat "$STUB_DIR/patients.json" 2>/dev/null || echo '[]')" ;;
      set-nightscout)
        echo "set-nightscout ${MELLIS_NIGHTSCOUT_URL} ${MELLIS_NIGHTSCOUT_TOKEN}" >> "$STUB_DIR/nightscout.log"
        case "$MELLIS_NIGHTSCOUT_TOKEN" in reader-*) echo '{"patient_id":"p1","nightscout":{"last_reading":{"value":131,"age_minutes":4},"uploader":"Loop"}}' ;; *) echo '{"error":"NIGHTSCOUT_TOKEN_INVALID"}'; exit 1 ;; esac ;;
      reset-owner|recovery-code)
        if [ "$command" = reset-owner ] && [ -n "${STUB_NO_PUBLIC_URL:-}" ]; then echo '{"error":"PUBLIC_BASE_URL_MISSING"}'; exit 1; fi
        user="u1"; name="Ania"
        if [ "${1:-}" = "--user" ]; then
          user="$2"; name="$(jq -r --arg u "$2" '.[] | select(.user_id == $u) | .display_name' "$STUB_DIR/owners.json" 2>/dev/null)"
          [ -n "$name" ] || { echo '{"error":"NOT_AN_OWNER"}'; exit 1; }
        fi
        if [ "$command" = recovery-code ]; then echo "{\"recovery_code\":\"NEWRC-NEWRC-NEWRC-NEWRC-NEWRC\",\"user_id\":\"$user\",\"display_name\":\"$name\"}"
        else echo "{\"code\":\"PAIR1-PAIR2-PAIR3-PAIR4\",\"expires_at\":\"2026-10-29T12:10:00.000Z\",\"pairing_url\":\"mellis://pair?server=https%3A%2F%2Fmellis.example&code=PAIR1-PAIR2-PAIR3-PAIR4\",\"user_id\":\"$user\",\"display_name\":\"$name\"}"; fi ;;
      knowledge-build)
        if [ -n "${STUB_KNOWLEDGE_FAIL:-}" ]; then echo '{"ok":false,"error":"Knowledge folder not found: /app/knowledge"}'; exit 1; fi
        if [ -n "$(env_value OPENAI_API_KEY)" ]; then mode=hybrid; else mode=bm25; fi
        echo "progress line on stderr" >&2
        echo "{\"ok\":true,\"status\":\"BUILT\",\"corpus_version\":\"mellis-knowledge-0123456789abcdef\",\"mode\":\"$mode\",\"documents\":207,\"indexed_documents\":204,\"skipped_documents\":3,\"chunks\":1250,\"embedding_error\":null,\"kept_version\":null}" ;;
      *) echo '{"error":"USAGE"}'; exit 2 ;;
    esac
    exit 0 ;;
esac
exit 0
STUB

cat > "$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
# curl stub: the local Mellis API (setup routes, app-config), the public address and GitHub releases.
out=""; format=""; method="GET"; data=""; fail=0; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) format="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    -H|-m) shift 2 ;;
    --data-binary) data="${2#@}"; shift 2 ;;
    -fsS|-fsSL|-f) fail=1; shift ;;
    -sS|-s|-S) shift ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
body=""; [ -n "$data" ] && body="$(cat "$data")"
printf 'curl %s %s %s\n' "$method" "$url" "$(printf '%s' "$body" | sed 's/"token":"[^"]*"/"token":"…"/')" >> "$STUB_DIR/curl.log"
env_value() { sed -n "s/^$1=//p" "$MELLIS_ROOT/.env" 2>/dev/null | tail -n 1; }
status=200; response='{}'
case "$url" in
  */v1/app-config)
    version="$(env_value MELLIS_VERSION)"
    if [ "${STUB_BROKEN_VERSION:-}" = "$version" ]; then exit 7; fi
    case "$url" in https://*) [ "${STUB_PUBLIC_OK:-1}" = 1 ] || exit 7 ;; esac
    response="{\"ios\":{\"min_build\":445},\"server\":{\"version\":\"$version\",\"revision\":null}}" ;;
  */v1/setup)
    response="{\"auth_mode\":\"device\",\"setup\":\"$(cat "$STUB_DIR/setup_state" 2>/dev/null || echo OPEN)\",\"setup_code_configured\":true,\"patients\":$(cat "$STUB_DIR/patients.json" 2>/dev/null || echo '[]')}" ;;
  */v1/setup/nightscout-check)
    case "$body" in
      *'"token":"reader-'*) response='{"nightscout":{"base_url":"https://ns.example","last_reading":{"value":142,"unit":"mg/dL","age_minutes":2},"uploader":"Trio 0.5"}}' ;;
      *'"token":"writer-'*) status=422; response='{"code":"NIGHTSCOUT_TOKEN_NOT_READ_ONLY","status":422}' ;;
      *) status=422; response='{"code":"NIGHTSCOUT_TOKEN_INVALID","status":422}' ;;
    esac ;;
  */v1/setup/patients)
    name="$(printf '%s' "$body" | sed -n 's/.*"display_name":"\([^"]*\)".*/\1/p')"
    current="$(cat "$STUB_DIR/patients.json" 2>/dev/null || echo '[]')"
    printf '%s' "$current" | jq --arg name "$name" '. + [{"patient_id":"p\(length + 1)","display_name":$name,"nightscout_url":"https://ns.example"}]' > "$STUB_DIR/patients.json"
    status=201; response="{\"patient\":{\"patient_id\":\"p1\",\"display_name\":\"$name\"}}" ;;
  */v1/setup/ai)
    key="$(printf '%s' "$body" | sed -n 's/.*"api_key":"\([^"]*\)".*/\1/p')"
    extra="$(printf '%s' "$body" | sed -n 's/.*"openai_api_key":"\([^"]*\)".*/\1/p')"
    case "$key" in *good*) ;; *) status=422; response='{"code":"AI_KEY_INVALID","title":"AI_KEY_INVALID: MAIN_KEY"}' ;; esac
    if [ "$status" = 200 ] && [ -n "$extra" ]; then case "$extra" in *good*) ;; *) status=422; response='{"code":"AI_KEY_INVALID","title":"AI_KEY_INVALID: OPENAI_API_KEY"}' ;; esac; fi
    [ "$status" = 200 ] && response='{"env":{},"capabilities":{},"checked":[]}' ;;
  */v1/setup/owner)
    status=201; response='{"user_id":"u1","first_name":"Ania","pairing":{"code":"X","expires_at":"2026-10-29T12:00:00Z","pairing_url":"mellis://pair?server=x&code=X"},"recovery_code":"4D8PE-QW2Z7-K9M3X-6HTB1-AAAAA"}' ;;
  *releases/latest) response="{\"tag_name\":\"v${STUB_LATEST:-$CUR}\"}" ;;
  *releases\?*) response="[{\"tag_name\":\"v${STUB_LATEST:-$CUR}\",\"draft\":false,\"prerelease\":false},{\"tag_name\":\"v1.0.0\",\"draft\":false,\"prerelease\":false}]" ;;
  *) status=404 ;;
esac
if [ -n "$out" ]; then printf '%s' "$response" > "$out"; else printf '%s' "$response"; fi
[ -n "$format" ] && printf '%s' "$status"
if [ "$fail" = 1 ] && [ "$status" -ge 400 ]; then exit 22; fi
exit 0
STUB

for tool in apt-get systemctl ufw qrencode timedatectl; do
  printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >> "$STUB_DIR/other.log"\n[ "%s" = qrencode ] && echo "[QR $*]"\nexit 0\n' "$tool" "$tool" > "$STUBS/$tool"
done
# No timedatectl answer (default zone) and no ss/ip: the checks that need them are skipped.
printf '#!/usr/bin/env bash\nexit 1\n' > "$STUBS/timedatectl"
chmod +x "$STUBS"/*

# A real P-256 key in PKCS#8, as Apple gives it.
P8="$WORK/AuthKey_ABCDE12345.p8"
openssl ecparam -genkey -name prime256v1 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$P8" 2>/dev/null

MEMINFO="$WORK/meminfo"
printf 'MemTotal:        2014400 kB\n' > "$MEMINFO"
OS_RELEASE="$WORK/os-release"
printf 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\nVERSION_CODENAME=noble\n' > "$OS_RELEASE"

# run_case NAME: a fresh server directory and stub state. Then `installer` / `tool` run the script with stdin.
new_case() {
  CASE="$WORK/$1"
  mkdir -p "$CASE/stub" "$CASE/bin"
  export STUB_DIR="$CASE/stub"
  export MELLIS_ROOT="$CASE/opt/mellis" MELLIS_KEEP_DIR="$CASE/opt/mellis-kopia" MELLIS_BIN_DIR="$CASE/bin" MELLIS_CRON_FILE="$CASE/cron.d/mellis" MELLIS_BASHRC="$CASE/.bashrc"
  export MELLIS_PUBLIC_IPV4=1 MELLIS_MIKRUS=0 # the same server type on a Mac and on a CI runner (private IPv4)
  export MELLIS_KIT_DIR="$REPO" MELLIS_ALLOW_NON_ROOT=1 MELLIS_OS_RELEASE="$OS_RELEASE" MELLIS_MEMINFO="$MEMINFO"
  export MELLIS_WAIT_SECONDS=1 MELLIS_SLEEP=0 HOME="$CASE"
  export MELLIS_ACCEPT_DIY=tak # the DIY acknowledgement accepted ahead; case 0 answers it on stdin
  export PATH="$STUBS:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
  unset STUB_BROKEN_VERSION STUB_PULL_FAIL_VERSION STUB_WORKER_DOWN_VERSION STUB_PUBLIC_OK STUB_LATEST STUB_KNOWLEDGE_FAIL STUB_COMPOSE_OLD SSH_CONNECTION
}
installer() { perl -e "alarm 40; exec @ARGV" bash ${MELLIS_TRACE:+-x} "$SCRIPT" install > "$CASE/out.txt" 2>&1; echo $? > "$CASE/status"; cat "$CASE/out.txt" >> "$CASE/all.txt"; }
tool() { perl -e "alarm 40; exec @ARGV" bash "$MELLIS_ROOT/mellis" "$@" > "$CASE/out.txt" 2>&1; echo $? > "$CASE/status"; cat "$CASE/out.txt" >> "$CASE/all.txt"; }
status_is() { [ "$(cat "$CASE/status")" = "$1" ]; }

p8_lines() { printf '  '; cat "$P8"; }

# --------------------------------------------------------------------------------------------------------------------
# 0. The DIY acknowledgement: anything but "tak" (or no answer) stops before any change; " TAK " goes on.
# --------------------------------------------------------------------------------------------------------------------
new_case consent
unset MELLIS_ACCEPT_DIY
echo "nie" | installer
check "consent refused: exit 1" status_is 1
check "consent: the notice shown" contains "$CASE/out.txt" "Mellis to projekt DIY, nie wyrób medyczny. Używasz go na własną odpowiedzialność; decyzje o leczeniu podejmujesz Ty."
check "consent refused: says nothing changed" contains "$CASE/out.txt" "Nic nie zostało zmienione."
check "consent refused: no server checks" not_contains "$CASE/out.txt" "Sprawdzam serwer"
check "consent refused: nothing installed" [ ! -e "$MELLIS_ROOT" ]
check "consent refused: docker never called" [ ! -s "$STUB_DIR/docker.log" ]
installer < /dev/null
check "consent, no answer: exit 1" status_is 1
check "consent, no answer: nothing installed" [ ! -e "$MELLIS_ROOT" ]
MELLIS_ACCEPT_DIY=nie installer < /dev/null
check "consent, MELLIS_ACCEPT_DIY other than tak: exit 1" status_is 1
# Accepted: the install goes on to the server checks (and stops at the first unanswered question).
echo " TAK " | installer
check "consent accepted: server checks start" contains "$CASE/out.txt" "Sprawdzam serwer"
check "consent accepted: not refused" not_contains "$CASE/out.txt" "Bez akceptacji"

# --------------------------------------------------------------------------------------------------------------------
# 1. Fresh install: OpenAI, Mikrus subdomain, a Nightscout link with ?token=, a write token refused first.
# --------------------------------------------------------------------------------------------------------------------
new_case fresh-openai
# Mikrus' Nightscout installer block in root's .bashrc; a line the owner edited must stay as it is.
cat > "$MELLIS_BASHRC" <<'BASHRC'
alias ll='ls -la'
if command -v nightscout-tool &> /dev/null; then
    echo -e "\n\nWpisz: nightscout-tool\n\n";
fi
    echo -e "\n\nWpisz: nightscout-tool (mój serwer)\n\n";
BASHRC
cp "$MELLIS_BASHRC" "$CASE/bashrc.before"
{
  echo 1                                              # Nowa instalacja
  echo "Kuba"; echo "2016"                             # the patient first, then their Nightscout
  echo "ns.example"                                    # Nightscout address
  echo "writer-123"                                    # write token: refused
  echo "https://ns.example/?token=reader-abc"          # link with ?token=
  echo "n"                                             # no other person
  echo 1; echo "sk-bad"; echo "sk-good-openai"         # OpenAI: bad key, then a good one
  echo "20"                                            # monthly limit
  echo "abcde12345"; echo "TEAM123456"; p8_lines       # APNs
  echo 2; echo "mellisania.mikrus.dev"                # Mikrus subdomain
} | installer
ENV="$MELLIS_ROOT/.env"
check "fresh: exit 0" status_is 0
check "fresh: login hint names Nightscout and Mellis" contains "$MELLIS_BASHRC" 'Zarządzanie Nightscout:\nWpisz: nightscout-tool\n\nZarządzanie Mellis:\nWpisz: mellis'
check "fresh: only the Nightscout installer's line changed" [ "$(diff "$CASE/bashrc.before" "$MELLIS_BASHRC" | grep -c '^[<>]')" = 2 ]
check "fresh: an edited line is left alone" contains "$MELLIS_BASHRC" 'Wpisz: nightscout-tool (mój serwer)'
check "fresh: .env is chmod 600" [ "$(stat -c %a "$ENV" 2>/dev/null || stat -f %Lp "$ENV")" = 600 ]
for line in AUTH_MODE=device REMOTE_COMMANDS_ENABLED=true AI_PROVIDER=openai OPENAI_API_KEY=sk-good-openai VOICE_TRANSCRIPTION_ENABLED=1 \
  OPENAI_TRANSCRIPTION_PRICING_PER_MINUTE=0.0045 OPENAI_PRICING_VERSION=openai.gpt-5.6-terra.2026-10 AI_EXPERIMENT_MAX_COST=0.25 \
  AI_BUDGETED_USAGE_SESSION=true AI_MONTHLY_LIMIT_USD=20 MELLIS_VERSION=$CUR PUSH_PROVIDER=apns APNS_KEY_ID=ABCDE12345 \
  APNS_TEAM_ID=TEAM123456 APNS_BUNDLE_ID=pl.mellis.TEAM123456 APNS_USE_SANDBOX=true API_PUBLISH=4100 \
  PUBLIC_BASE_URL=https://mellisania.mikrus.dev COMPOSE_PROFILES= AI_LEDGER_FILE=ai-usage-ledger.json; do
  check "fresh: .env has $line" grep -qx -- "$line" "$ENV"
done
check "fresh: SETUP_CODE in the server's code format" grep -Eqx 'SETUP_CODE=[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}' "$ENV"
check "fresh: encryption key 32 bytes hex" grep -Eqx 'NIGHTSCOUT_TOKEN_ENCRYPTION_KEY=[0-9a-f]{64}' "$ENV"
check "fresh: postgres password generated" grep -Eqx 'POSTGRES_PASSWORD=[0-9a-f]{64}' "$ENV"
check "fresh: APNs key stored" contains "$MELLIS_ROOT/secrets/apns.p8" "END PRIVATE KEY"
check "fresh: write token refused with the docs' message" contains "$CASE/out.txt" "Nie udało się połączyć z Nightscoutem: ten token ma prawo zapisu"
check "fresh: token split from the link" contains "$CASE/out.txt" "Token odczytany z linku."
check "fresh: Nightscout asked for the named patient" contains "$CASE/out.txt" "Nightscout dla: "
check "fresh: newest reading shown" contains "$CASE/out.txt" "✓ Połączono. Ostatni odczyt: 142 mg/dL, 2 min temu. Pętla: Trio 0.5."
check "fresh: bad AI key named" contains "$CASE/out.txt" "Klucz AI nie działa"
check "fresh: Mikrus steps: panel" contains "$CASE/out.txt" "1. Otwórz panel Mikrusa → Sieć i domeny → Subdomeny."
check "fresh: Mikrus steps: port" contains "$CASE/out.txt" "2. Dodaj subdomenę: nazwa z samych liter i cyfr (np. mellisania), port: 4100."
check "fresh: Mikrus steps: copy" contains "$CASE/out.txt" "3. Panel pokaże jej adres, np. https://mellisania.mikrus.dev: skopiuj go."
check "fresh: Mikrus steps: paste" contains "$CASE/out.txt" "4. Wklej go tutaj i naciśnij Enter."
check "fresh: Mikrus prompt" contains "$CASE/out.txt" "Adres subdomeny z panelu Mikrusa (np. https://mellisania.mikrus.dev):"
check "fresh: compose quiet" grep -q 'compose .*--progress quiet up -d' "$STUB_DIR/docker.log"
check "fresh: no compose progress on the screen" not_contains "$CASE/out.txt" "[+] Running"
check "fresh: every run with -T" not_contains "$STUB_DIR/docker.log" "run --rm migrate"
check "fresh: patient created through the setup API" grep -q 'POST http://127.0.0.1:4100/v1/setup/patients {"display_name":"Kuba","birth_year":2016' "$STUB_DIR/curl.log"
check "fresh: owner left to install-app.sh (recovery code made on the Mac)" not_contains "$STUB_DIR/curl.log" "/v1/setup/owner"
check "fresh: AI checked through the setup API" grep -q 'POST http://127.0.0.1:4100/v1/setup/ai' "$STUB_DIR/curl.log"
check "fresh: the AI key not logged by the stub's docker" not_contains "$STUB_DIR/admin.log" "check-ai"
check "fresh: the Nightscout token never on a docker command line" not_contains "$STUB_DIR/docker.log" "reader-abc"
check "fresh: the AI key never on a docker command line" not_contains "$STUB_DIR/docker.log" "sk-good-openai"
check "fresh: monthly ledger with the limit" grep -q "admin ai-limit --total 20" "$STUB_DIR/admin.log"
check "fresh: summary Nightscout history note" contains "$CASE/out.txt" "Mellis wczytuje teraz w tle historię z Nightscouta z 30 dni (zwykle około 5 minut). Do tego czasu analizy dłuższych okresów będą niepełne."
check "fresh: summary address" contains "$CASE/out.txt" "Adres serwera:      https://mellisania.mikrus.dev"
check "fresh: summary setup code = SETUP_CODE" contains "$CASE/out.txt" "Kod konfiguracji:   $(sed -n 's/^SETUP_CODE=//p' "$ENV")   (do instalacji aplikacji)"
check "fresh: no recovery code on the server" not_contains "$CASE/out.txt" "Kod odzyskiwania:"
check "fresh: Mac command with server and code" contains "$CASE/out.txt" "scripts/install-app.sh)\" -- --server https://mellisania.mikrus.dev --code $(sed -n 's/^SETUP_CODE=//p' "$ENV")"
check "fresh: first backup" ls "$MELLIS_ROOT"/backups/mellis-"$CUR"-*.tar.gz
check "fresh: mellis command" [ -L "$MELLIS_BIN_DIR/mellis" ]
check "fresh: nightly backup cron at 03:00" grep -q '^0 3 \* \* \* root .*/mellis backup --cron' "$MELLIS_CRON_FILE"
check "fresh: compose project is mellis only" grep -q 'compose --project-name mellis' "$STUB_DIR/docker.log"
check "fresh: knowledge base built" grep -qx "admin knowledge-build " "$STUB_DIR/admin.log"
check "fresh: knowledge build after the AI ledger" [ "$(grep -n 'admin ai-limit' "$STUB_DIR/admin.log" | head -n 1 | cut -d: -f1)" -lt "$(grep -n 'admin knowledge-build' "$STUB_DIR/admin.log" | head -n 1 | cut -d: -f1)" ]
check "fresh: knowledge build before the stack starts with the flag" [ "$(grep -n 'mellis-admin.js knowledge-build' "$STUB_DIR/docker.log" | head -n 1 | cut -d: -f1)" -lt "$(grep -n 'up -d --remove-orphans' "$STUB_DIR/docker.log" | tail -n 1 | cut -d: -f1)" ]
check "fresh: knowledge search switched on" grep -qx "AI_ENABLE_KNOWLEDGE_SEARCH=1" "$ENV"
check "fresh: knowledge with OpenAI vectors" contains "$CASE/out.txt" "Baza wiedzy gotowa."
check "fresh: knowledge not word-only with an OpenAI key" not_contains "$CASE/out.txt" "wyszukiwanie po słowach"

# The backup: database, photos, ledger, settings without any key.
BACKUP="$(ls "$MELLIS_ROOT"/backups/mellis-"$CUR"-*.tar.gz | head -n 1)"
mkdir -p "$CASE/unpacked" && tar -C "$CASE/unpacked" -xzf "$BACKUP"
check "backup: database dump" contains "$CASE/unpacked/database.dump" "PGDMP"
check "backup: manifest version" grep -qx "version=$CUR" "$CASE/unpacked/manifest.txt"
check "backup: photos directory" [ -d "$CASE/unpacked/photos" ]
check "backup: settings kept" grep -qx "APNS_KEY_ID=ABCDE12345" "$CASE/unpacked/settings.env"
for secret in OPENAI_API_KEY ANTHROPIC_API_KEY POSTGRES_PASSWORD SETUP_CODE NIGHTSCOUT_TOKEN_ENCRYPTION_KEY CLOUDFLARE_TUNNEL_TOKEN; do
  check "backup: no $secret" not_contains "$CASE/unpacked/settings.env" "$secret="
done
check "backup: no key value anywhere" not_contains "$CASE/unpacked/settings.env" "sk-good"
check "backup: no APNs key" not_contains "$CASE/unpacked/settings.env" "PRIVATE KEY"

# Rerun = already installed.
installer
check "rerun: says it is installed" contains "$CASE/out.txt" "Mellis jest już zainstalowany"

# The menu tool: status, pair-owner, report.
echo '[{"patient_id":"p1","display_name":"Kuba","nightscout_url":"https://ns.example","has_token":true,"last_reading_at":"2026-10-29T11:58:59.383Z"}]' > "$STUB_DIR/patients.json"
tool status
check "status: version and AI spending" contains "$CASE/out.txt" "wydano 1.5 z 20"
check "status: TZ from .env" grep -qx "TZ=Europe/Warsaw" "$ENV"
check "status: reading time in Warsaw (12:58), not UTC ISO" contains "$CASE/out.txt" "Nightscout · Kuba: ostatni odczyt "
check "status: reading at 12:58 Warsaw" grep -Eq "ostatni odczyt ([0-9.]+ )?12:58, " "$CASE/out.txt"
check "status: no UTC ISO time" not_contains "$CASE/out.txt" "2026-10-29T11:58"
check "status: backup age friendly" grep -Eq "Ostatnia kopia: [0-9]{2}:[0-9]{2}, (przed chwilą|[0-9]+ min temu)" "$CASE/out.txt"
tool pair-owner
check "pair-owner: QR and link" contains "$CASE/out.txt" "mellis://pair?server=https%3A%2F%2Fmellis.example&code=PAIR1-PAIR2-PAIR3-PAIR4"
check "pair-owner: QR drawn" contains "$CASE/out.txt" "[QR -t ANSIUTF8"
check "pair-owner, one owner: no question" not_contains "$CASE/out.txt" "Kogo połączyć?"
check "pair-owner, one owner: the server's default" grep -qx "admin reset-owner " "$STUB_DIR/admin.log"
check "pair-owner: expiry in the server's zone" contains "$CASE/out.txt" "(do 13:10)."
export STUB_NO_PUBLIC_URL=1
tool pair-owner
check "pair-owner without PUBLIC_BASE_URL: says where to set the address" contains "$CASE/out.txt" "Serwer nie zna swojego adresu"
check "pair-owner without PUBLIC_BASE_URL: no link" not_contains "$CASE/out.txt" "Albo wklej w aplikacji link"
export STUB_NO_PUBLIC_URL=
tool report
REPORT="$(ls "$MELLIS_ROOT"/mellis-raport-*.txt 2>/dev/null | head -n 1)"
[ -z "$REPORT" ] && REPORT="$CASE/out.txt"
check "report: event names" contains "$CASE/out.txt" "nightscout_sync_ok"
check "report: error codes" contains "$CASE/out.txt" "APNS_BAD_DEVICE_TOKEN"
for leak in "Kuba" "secret-host" "mellisania.mikrus.dev" "sk-good" "142" "abcdef" "$(sed -n 's/^SETUP_CODE=//p' "$ENV")"; do
  check "report: no '$leak'" not_contains "$CASE/out.txt" "$leak"
done
tool download
check "download: scp into ~/Mellis-kopie, port as a placeholder" contains "$CASE/out.txt" "mkdir -p ~/Mellis-kopie && scp -P PORT root@ADRES-SERWERA:$MELLIS_ROOT/backups/mellis-${CUR}-"
check "download: port and address from the note" contains "$CASE/out.txt" 'PORT i ADRES-SERWERA jak w komendzie ssh z notatki „Mellis”.'
# The port this server sees is not the Mac's (Mikrus: 10123 outside, 22 inside): never printed.
SSH_CONNECTION="203.0.113.5 50000 10.0.0.2 22" tool download
check "download: no port guessed from SSH_CONNECTION" not_contains "$CASE/out.txt" "scp -P 22 "

# --------------------------------------------------------------------------------------------------------------------
# 2. Update: success, then a broken release that rolls back with the database.
# --------------------------------------------------------------------------------------------------------------------
# A release tag that is not X.Y.Z never reaches the image tag or the .env.
export STUB_LATEST='1.1.0;touch /tmp/x'
tool update
check "odd release tag: refused" status_is 1
check "odd release tag: version unchanged" grep -qx "MELLIS_VERSION=$CUR" "$ENV"
tool update '1.1.0$(id)'
check "odd version argument: refused" status_is 1
check "odd version argument: says why" contains "$CASE/out.txt" "Wersja to trzy liczby"
export STUB_LATEST=1.1.0
tool update
check "update: exit 0" status_is 0
check "update: version in .env" grep -qx "MELLIS_VERSION=1.1.0" "$ENV"
check "update: backup before" ls "$MELLIS_ROOT"/backups/mellis-"$CUR"-*-przed-1.1.0.tar.gz
check "update: says it works" contains "$CASE/out.txt" "Mellis 1.1.0 działa."
check "update: knowledge base checked again" [ "$(grep -c 'admin knowledge-build' "$STUB_DIR/admin.log")" -ge 2 ]
check "update: knowledge search stays on" grep -qx "AI_ENABLE_KNOWLEDGE_SEARCH=1" "$ENV"
export STUB_LATEST=1.2.0 STUB_WORKER_DOWN_VERSION=1.2.0
: > "$STUB_DIR/postgres.log"
tool update
check "broken update: exit 1" status_is 1
check "broken update: back to 1.1.0" grep -qx "MELLIS_VERSION=1.1.0" "$ENV"
check "broken update: database restored" grep -q "pg_restore -U glucomind -d glucomind --no-owner --no-privileges" "$STUB_DIR/postgres.log"
check "broken update: dropped and recreated first" grep -q "DROP DATABASE IF EXISTS glucomind" "$STUB_DIR/postgres.log"
check "broken update: tells so" contains "$CASE/out.txt" "Mellis 1.1.0 działa jak przed aktualizacją"
unset STUB_WORKER_DOWN_VERSION

# --------------------------------------------------------------------------------------------------------------------
# 3. Restore from the menu (same server: no Nightscout questions), then uninstall keeping the data.
# --------------------------------------------------------------------------------------------------------------------
: > "$STUB_DIR/nightscout.log"
printf '1\nt\n' | tool restore
check "restore: exit 0" status_is 0
check "restore: safety backup first" ls "$MELLIS_ROOT"/backups/*przed-przywroceniem.tar.gz
check "restore: same server asks no tokens" [ ! -s "$STUB_DIR/nightscout.log" ]

printf '1\nt\n' | tool uninstall
check "uninstall keep: exit 0" status_is 0
check "uninstall keep: backup kept" ls "$MELLIS_KEEP_DIR"/mellis-*-odinstalowanie.tar.gz
check "uninstall keep: settings without keys" not_contains "$MELLIS_KEEP_DIR/settings.env" "sk-good"
check "uninstall keep: directory removed" [ ! -d "$MELLIS_ROOT" ]
check "uninstall keep: cron removed" [ ! -f "$MELLIS_CRON_FILE" ]
check "uninstall keep: command removed" [ ! -e "$MELLIS_BIN_DIR/mellis" ]
check "uninstall keep: login hint back to the original" cmp -s "$CASE/bashrc.before" "$MELLIS_BASHRC"
check "uninstall: only the mellis project's containers and volumes" grep -q 'compose --project-name mellis .* down -v --remove-orphans' "$STUB_DIR/docker.log"
check "uninstall: nothing else stopped" not_contains "$STUB_DIR/docker.log" "docker stop"
KEPT="$(ls "$MELLIS_KEEP_DIR"/mellis-*-odinstalowanie.tar.gz | head -n 1)"

# --------------------------------------------------------------------------------------------------------------------
# 4. Reinstall with "Przywróć z kopii" from the kept Mellis backup: tokens asked again, keys asked again.
# --------------------------------------------------------------------------------------------------------------------
new_case restore-mellis
mkdir -p "$MELLIS_KEEP_DIR" && cp "$KEPT" "$MELLIS_KEEP_DIR/"
echo COMPLETED > "$STUB_DIR/setup_state"; echo true > "$STUB_DIR/has_recovery"
echo '[{"patient_id":"p1","display_name":"Kuba","nightscout_url":"https://ns.example","has_token":true}]' > "$STUB_DIR/patients.json"
{
  echo 2; echo ""                                      # Przywróć z kopii, default file (the kept one)
  echo ""; echo "reader-new"                           # Kuba's Nightscout: default address, new token
  echo 2; echo "sk-ant-good"; echo ""                  # Claude, no OpenAI key
  echo ""                                              # limit: default from the backup (20)
  echo ""; echo ""; p8_lines                           # APNs IDs from the backup
  echo 1; echo "mellis.example.pl"                     # own domain
} | installer
ENV="$MELLIS_ROOT/.env"
check "restore install: exit 0" status_is 0
check "restore install: database restored" grep -q "pg_restore" "$STUB_DIR/postgres.log"
check "restore install: Nightscout token stored again" grep -q "set-nightscout https://ns.example reader-new" "$STUB_DIR/nightscout.log"
check "restore install: limit from the backup" grep -qx "AI_MONTHLY_LIMIT_USD=20" "$ENV"
check "restore install: APNs key id from the backup" grep -qx "APNS_KEY_ID=ABCDE12345" "$ENV"
check "restore install: Claude without voice on the server" grep -qx "VOICE_TRANSCRIPTION_ENABLED=0" "$ENV"
check "restore install: Claude call limit" grep -qx "AI_EXPERIMENT_MAX_COST=1" "$ENV"
check "restore install: own domain with Caddy" grep -qx "COMPOSE_PROFILES=caddy" "$ENV"
check "restore install: domain" grep -qx "DOMAIN=mellis.example.pl" "$ENV"
check "restore install: no setup calls" not_contains "$STUB_DIR/curl.log" "/v1/setup/patients"
check "restore install: summary Nightscout history note" contains "$CASE/out.txt" "Mellis wczytuje teraz w tle historię z Nightscouta z 30 dni (zwykle około 5 minut). Do tego czasu analizy dłuższych okresów będą niepełne."
check "restore install: pair with the menu" contains "$CASE/out.txt" "Kod konfiguracji:   —   (telefon połączysz: mellis → Połącz telefon właściciela)"
check "restore install: recovery code kept" contains "$CASE/out.txt" "Kod odzyskiwania z notatki działa dalej."
check "restore install: AI checked by the server CLI (setup closed)" grep -q "admin check-ai" "$STUB_DIR/admin.log"
check "restore install: Claude only = word search" contains "$CASE/out.txt" "Baza wiedzy gotowa (wyszukiwanie po słowach)."
check "restore install: knowledge search on" grep -qx "AI_ENABLE_KNOWLEDGE_SEARCH=1" "$ENV"

# --------------------------------------------------------------------------------------------------------------------
# 5. Cognito-era backup (a plain pg_dump): new recovery code, interrupted run continues.
# --------------------------------------------------------------------------------------------------------------------
new_case restore-cognito
printf 'PGDMP old production dump' > "$CASE/glucomind-20261029.dump"
echo COMPLETED > "$STUB_DIR/setup_state"; echo false > "$STUB_DIR/has_recovery"
echo '[{"patient_id":"p1","display_name":"Kuba","nightscout_url":null,"has_token":false}]' > "$STUB_DIR/patients.json"
# Two owners in the old database: a leftover test person created first (never used) and the real owner.
cat > "$STUB_DIR/owners.json" <<'JSON'
[{"user_id":"u-tester","display_name":"iPhone Tester","created_at":"2025-12-01T10:00:00.000Z","devices":0,"auth_identities":0,"has_login_history":false,"last_active_at":null,"recovery_person":false},
 {"user_id":"u-ania","display_name":"Ania","created_at":"2026-01-01T10:00:00.000Z","devices":2,"auth_identities":1,"has_login_history":true,"last_active_at":"2026-10-28T08:00:00.000Z","recovery_person":false}]
JSON
{ echo 2; echo "$CASE/glucomind-20261029.dump"; echo "https://ns.example?token=reader-old"; } | installer
check "restore file: scp to the server with placeholders" contains "$CASE/out.txt" "scp -P PORT ~/Mellis-kopie/NAZWA-PLIKU root@ADRES-SERWERA:/root/"
check "restore file: port and address from the note" contains "$CASE/out.txt" 'PORT i ADRES-SERWERA jak w komendzie ssh z notatki „Mellis”.'
check "interrupted: stops on missing answers" status_is 1
check "interrupted: tells how to continue" contains "$CASE/out.txt" "Uruchom ją ponownie"
: > "$STUB_DIR/postgres.log"
export STUB_KNOWLEDGE_FAIL=1
{
  echo 1; echo "sk-good-2"; echo "15"
  echo "ABCDE12345"; echo "TEAM123456"; p8_lines
  echo 3; echo "eyJhIjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiJ9"; echo "mellis.home.example"
} | installer
ENV="$MELLIS_ROOT/.env"
check "continued: exit 0 although the knowledge build failed" status_is 0
check "continued: knowledge failure explained" contains "$CASE/out.txt" "Bazy wiedzy nie udało się przygotować"
check "continued: knowledge search stays off" grep -qx "AI_ENABLE_KNOWLEDGE_SEARCH=0" "$ENV"
check "continued: not restored twice" not_contains "$STUB_DIR/postgres.log" "pg_restore"
check "continued: points to a new recovery code" contains "$CASE/out.txt" "mellis → Odzyskaj dostęp właściciela"
check "continued: several owners: says who to pick when pairing" contains "$CASE/out.txt" 'Kopia ma 2 właścicieli: przy łączeniu telefonu Mellis zapyta „Kogo połączyć?”'
check "continued: setup code dash" contains "$CASE/out.txt" "Kod konfiguracji:   —"
check "continued: Cloudflare Tunnel" grep -qx "COMPOSE_PROFILES=tunnel" "$ENV"
check "continued: tunnel token" grep -qx "CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiJ9" "$ENV"
check "continued: API only local behind the tunnel" grep -Eqx "API_PUBLISH=127.0.0.1:[0-9]+" "$ENV"
export STUB_KNOWLEDGE_FAIL=
tool knowledge
check "mellis knowledge: retried and switched on" grep -qx "AI_ENABLE_KNOWLEDGE_SEARCH=1" "$ENV"

# Several owners: "Kogo połączyć?" with names and hints; Enter = the most recently active one.
: > "$STUB_DIR/admin.log"
echo "" | tool pair-owner
check "pair several: asks" contains "$CASE/out.txt" "Kogo połączyć?"
check "pair several: the tester named, never used" contains "$CASE/out.txt" "1. iPhone Tester · nigdy nie używany (bez logowania i wiadomości) · bez telefonu"
check "pair several: the owner with last activity and phones" grep -Eq "2\. Ania · ostatnio aktywny 28\.10\.2026 09:00, [0-9]+ (dzień|dni) temu · 2 telefony" "$CASE/out.txt"
check "pair several: default = most recently active" contains "$CASE/out.txt" "Wybierz numer [2]:"
check "pair several: pairs the one chosen" grep -qx "admin reset-owner --user u-ania" "$STUB_DIR/admin.log"
check "pair several: title with the name" contains "$CASE/out.txt" "Połącz telefon: Ania"
printf '1\n' | tool pair-owner
check "pair several: another choice" grep -qx "admin reset-owner --user u-tester" "$STUB_DIR/admin.log"
printf '2\nt\n' | tool recover-owner
check "recover several: recovery code for the person paired" grep -qx "admin recovery-code --user u-ania" "$STUB_DIR/admin.log"
check "recover several: new code shown" contains "$CASE/out.txt" "NEWRC-NEWRC-NEWRC-NEWRC-NEWRC"

# An older compose without --progress quiet: progress goes to a log, never to the screen.
export STUB_COMPOSE_OLD=1
: > "$STUB_DIR/docker.log"
tool backup
check "old compose: no quiet flag" not_contains "$STUB_DIR/docker.log" "--progress quiet"
check "old compose: no progress on the screen" not_contains "$CASE/out.txt" "[+] Running"
check "old compose: progress in the log" contains "$MELLIS_ROOT/state/compose.log" "[+] Running"
unset STUB_COMPOSE_OLD

# Uninstall "Usuń wszystko" with the answers piped in: docker never eats them (exec/run read no stdin).
printf '2\n\nUSUŃ\n' | tool uninstall
check "uninstall all piped: exit 0" status_is 0
check "uninstall all: scp with placeholders" contains "$CASE/out.txt" "scp -P PORT root@ADRES-SERWERA:"
check "uninstall all: port and address from the note" contains "$CASE/out.txt" 'PORT i ADRES-SERWERA jak w komendzie ssh z notatki „Mellis”.'
check "uninstall all piped: answers reached the questions" contains "$CASE/out.txt" "Mellis usunięty w całości."
check "uninstall all piped: directory removed" [ ! -d "$MELLIS_ROOT" ]

# --------------------------------------------------------------------------------------------------------------------
# 6. Checks: too little memory.
# --------------------------------------------------------------------------------------------------------------------
new_case small
printf 'MemTotal:         503000 kB\n' > "$CASE/meminfo"
MELLIS_MEMINFO="$CASE/meminfo" bash "$SCRIPT" install < /dev/null > "$CASE/out.txt" 2>&1; echo $? > "$CASE/status"
check "small: refused" status_is 1
check "small: docs' message" contains "$CASE/out.txt" "Za mało pamięci RAM"

# --------------------------------------------------------------------------------------------------------------------
# 7. Version order (update notice, update/rollback direction, backups): numbers, not text, so 1.0.10 > 1.0.9.
# --------------------------------------------------------------------------------------------------------------------
eval "$(grep -E '^version_gt\(\) ' "$SCRIPT")"
not_gt() { ! version_gt "$1" "$2"; }
check "version_gt: the definition was found" declare -F version_gt
check "version_gt: 1.0.10 > 1.0.9" version_gt 1.0.10 1.0.9
check "version_gt: 1.0.9 is not > 1.0.10" not_gt 1.0.9 1.0.10
check "version_gt: 1.10.0 > 1.9.9" version_gt 1.10.0 1.9.9
check "version_gt: 2.0.0 > 1.99.99" version_gt 2.0.0 1.99.99
check "version_gt: equal is not newer" not_gt 1.0.10 1.0.10

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
