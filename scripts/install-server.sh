#!/usr/bin/env bash
# Mellis server: the installer and, installed as /usr/local/bin/mellis, the management tool. One file, so the installer
# and the menu always share the same steps (docs-site/docs/instalacja/serwer.md, utrzymanie/*.md).
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.1/scripts/install-server.sh)"
#
# Ubuntu 24.04 / Debian 12, as root or with sudo. Re-running continues where an interrupted run stopped. Everything
# lives in /opt/mellis (compose project "mellis"); nothing outside that directory, its containers and volumes, the
# `mellis` command and /etc/cron.d/mellis is ever touched, so a Nightscout on the same server keeps running.
#
# mellis                       the menu
# mellis status | logs | report | update [X.Y.Z] | backup | restore [file] | download | settings | pair-owner
#        recover-owner | uninstall | setup-code | check-update | knowledge | version | install
#
# Test hooks (scripts/tests/install-server.test.sh): MELLIS_ROOT, MELLIS_BIN_DIR, MELLIS_CRON_FILE, MELLIS_KIT_DIR (take
# the compose file and this script from a checkout instead of the image), MELLIS_ALLOW_NON_ROOT, MELLIS_OS_RELEASE,
# MELLIS_MEMINFO, MELLIS_WAIT_SECONDS, MELLIS_SLEEP. MELLIS_LOCAL_IMAGE=1: use an image already built on this server.
# Before anything is installed the person types "tak" to accept that Mellis is a DIY project, not a medical device
# (accept_diy). MELLIS_ACCEPT_DIY=tak accepts it ahead (unattended installs, the tests); without it the question is
# asked, and no answer (no terminal, end of input) stops the install: it is never accepted silently.
# Polish quotation marks („…”) in messages are intended.
# shellcheck disable=SC1111
set -Eeuo pipefail

# The release this installer pins; written by scripts/sync-version.sh from package.json "version".
MELLIS_DEFAULT_VERSION="1.0.1"

MELLIS_ROOT="${MELLIS_ROOT:-/opt/mellis}"
MELLIS_KEEP_DIR="${MELLIS_KEEP_DIR:-/opt/mellis-kopia}"
MELLIS_BIN_DIR="${MELLIS_BIN_DIR:-/usr/local/bin}"
MELLIS_CRON_FILE="${MELLIS_CRON_FILE:-/etc/cron.d/mellis}"
MELLIS_IMAGE_DEFAULT="ghcr.io/mheblewski/mellis"
MELLIS_REPO="${MELLIS_REPO:-mheblewski/Mellis}"
# The step-by-step key pages, shown under each key question (a fork gets its own GitHub Pages address).
MELLIS_DOCS="${MELLIS_DOCS:-https://${MELLIS_REPO%%/*}.github.io/${MELLIS_REPO#*/}}"
KEYS_DOC="$MELLIS_DOCS/instalacja/klucze/"
MELLIS_OS_RELEASE="${MELLIS_OS_RELEASE:-/etc/os-release}"
MELLIS_MEMINFO="${MELLIS_MEMINFO:-/proc/meminfo}"
MELLIS_WAIT_SECONDS="${MELLIS_WAIT_SECONDS:-180}"
MELLIS_SLEEP="${MELLIS_SLEEP:-3}"
BACKUP_KEEP_DAYS=14
ADMIN_CLI="dist/apps/api/src/cli/mellis-admin.js"

ENV_FILE="$MELLIS_ROOT/.env"
STATE_DIR="$MELLIS_ROOT/state"
BACKUP_DIR="$MELLIS_ROOT/backups"

# --------------------------------------------------------------------------------------------------------------------
# Output and questions
# --------------------------------------------------------------------------------------------------------------------

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_ERR=""; C_WARN=""; C_BOLD=""; C_DIM=""; C_OFF=""
fi

say() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
err() { printf '%s✗%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }
die() { err "$*"; exit 1; }
title() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }
hint() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
pause() { sleep "$MELLIS_SLEEP"; }

# ask VAR "Pytanie" [domyślna]: one line; EOF (no answer at all) stops the run instead of looping. Locals are named
# __… so that the caller's variable (often "answer") is the one set.
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __answer=""
  if [ -n "$__default" ]; then __prompt="$__prompt [$__default]"; fi
  printf '%s: ' "$__prompt"
  if ! IFS= read -r __answer; then printf '\n'; die "Brak odpowiedzi: instalacja przerwana. Uruchom ją ponownie, żeby dokończyć."; fi
  __answer="${__answer%$'\r'}"
  __answer="$(printf '%s' "$__answer" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$__answer" ] && __answer="$__default"
  printf -v "$__var" '%s' "$__answer"
}

# ask_secret VAR "Pytanie": nothing is shown while typing or pasting; "••••••••" afterwards.
ask_secret() {
  local __var="$1" __prompt="$2" __answer=""
  printf '%s: ' "$__prompt"
  if [ -t 0 ]; then
    IFS= read -rs __answer || die "Brak odpowiedzi: instalacja przerwana. Uruchom ją ponownie, żeby dokończyć."
    if [ -n "$__answer" ]; then printf '••••••••\n'; else printf '\n'; fi
  else
    IFS= read -r __answer || { printf '\n'; die "Brak odpowiedzi: instalacja przerwana. Uruchom ją ponownie, żeby dokończyć."; }
    printf '\n'
  fi
  __answer="$(printf '%s' "${__answer%$'\r'}" | tr -d '[:space:]')"
  printf -v "$__var" '%s' "$__answer"
}

# The medical-safety acknowledgement, shown before the install changes anything (docs-site/docs/instalacja/serwer.md).
DIY_NOTICE="Mellis to projekt DIY, nie wyrób medyczny. Używasz go na własną odpowiedzialność; decyzje o leczeniu podejmujesz Ty."

# accept_diy: 0 after "tak" (any case, spaces trimmed) or MELLIS_ACCEPT_DIY=tak; anything else exits, nothing changed.
accept_diy() {
  local __accept
  title "Zanim zaczniesz"
  say "$DIY_NOTICE"
  __accept="$(printf '%s' "${MELLIS_ACCEPT_DIY:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  if [ "$__accept" = "tak" ]; then ok "Zaakceptowane (MELLIS_ACCEPT_DIY)."; return 0; fi
  ask __accept "Wpisz „tak”, jeśli to rozumiesz i akceptujesz"
  __accept="$(printf '%s' "$__accept" | tr '[:upper:]' '[:lower:]')"
  [ "$__accept" = "tak" ] || die "Bez akceptacji instalacja się nie zacznie. Nic nie zostało zmienione."
}

# ask_yes "Pytanie" t|n: 0 for yes. Polish t/tak, English y/yes also work.
ask_yes() {
  local __prompt="$1" __default="${2:-n}" __yes
  if [ "$__default" = "t" ]; then __prompt="$__prompt [T/n]"; else __prompt="$__prompt [t/N]"; fi
  ask __yes "$__prompt"
  __yes="$(printf '%s' "${__yes:-$__default}" | tr '[:upper:]' '[:lower:]')"
  case "$__yes" in t|tak|y|yes) return 0 ;; *) return 1 ;; esac
}

# choose VAR "Pytanie" default "opcja 1" "opcja 2" ...: VAR = the number chosen.
choose() {
  local __var="$1" __prompt="$2" __default="$3" __index=1 __choice __option
  shift 3
  [ -n "$__prompt" ] && say "$__prompt"
  for __option in "$@"; do say "  $__index. $__option"; __index=$((__index + 1)); done
  while :; do
    ask __choice "Wybierz numer" "$__default"
    if [[ "$__choice" =~ ^[0-9]+$ ]] && [ "$__choice" -ge 1 ] && [ "$__choice" -le "$#" ]; then break; fi
    warn "Wpisz numer od 1 do $#."
  done
  printf -v "$__var" '%s' "$__choice"
}

# --------------------------------------------------------------------------------------------------------------------
# .env and state
# --------------------------------------------------------------------------------------------------------------------

env_get() {
  local key="$1" file="${2:-$ENV_FILE}"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# env_set KEY VALUE [file]: replaces or appends one line; a value never spans lines. The file stays chmod 600.
env_set() {
  local key="$1" value="$2" file="${3:-$ENV_FILE}" tmp
  value="$(printf '%s' "$value" | tr -d '\r\n')"
  umask 077
  touch "$file"
  tmp="$(mktemp "$file.XXXXXX")"
  # ENVIRON, not -v: awk would read backslashes in a value as escapes.
  ENV_KEY="$key" ENV_VALUE="$value" awk '
    BEGIN { done = 0; key = ENVIRON["ENV_KEY"]; value = ENVIRON["ENV_VALUE"] }
    index($0, key "=") == 1 { if (!done) { print key "=" value; done = 1 }; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
  chmod 600 "$file"
}

state_get() { env_get "$1" "$STATE_DIR/install.state"; }
state_set() { mkdir -p "$STATE_DIR"; env_set "$1" "$2" "$STATE_DIR/install.state"; }

# Keys and tokens never go into a backup or a report: every line whose name says it is a secret is dropped.
secret_key_pattern='^(OPENAI_API_KEY|ANTHROPIC_API_KEY|NIGHTSCOUT_TOKEN_ENCRYPTION_KEY|NIGHTSCOUT_API_TOKEN|POSTGRES_PASSWORD|SETUP_CODE|CLOUDFLARE_TUNNEL_TOKEN|APNS_PRIVATE_KEY|[A-Z0-9_]*(SECRET|PASSWORD|API_KEY|_TOKEN))='
settings_without_keys() {
  grep -Ev "$secret_key_pattern" "$1" | grep -v '^#' || true
}

# A random code in the server's format (Crockford base32, groups of 5): SETUP_CODE.
random_code() {
  local alphabet="0123456789ABCDEFGHJKMNPQRSTVWXYZ" groups="${1:-4}" out="" byte i
  for ((i = 0; i < groups * 5; i++)); do
    byte=$(od -An -N1 -tu1 /dev/urandom | tr -d ' ')
    out+="${alphabet:$((byte % 32)):1}"
    if (( (i + 1) % 5 == 0 && i + 1 < groups * 5 )); then out+="-"; fi
  done
  printf '%s' "$out"
}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

version_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

# --------------------------------------------------------------------------------------------------------------------
# Docker, the compose project and the server's own commands
# --------------------------------------------------------------------------------------------------------------------

image_name() { local image; image="$(env_get MELLIS_IMAGE)"; printf '%s' "${image:-$MELLIS_IMAGE_DEFAULT}"; }
current_version() { env_get MELLIS_VERSION; }

# Times for people: the server's zone from .env (TZ, the containers' zone too), never the host clock (often UTC).
server_tz() { local tz; tz="$(env_get TZ)"; printf '%s' "${tz:-Europe/Warsaw}"; }
# jq: epoch (ISO 8601 UTC from the server CLI, or seconds), ago ("2 min temu"), local_when ("12:58, 2 min temu";
# another day: "28.10.2026 03:00, 1 dzień temu"), local_clock ("12:58"). jq's strflocaltime follows TZ.
# shellcheck disable=SC2016 # jq, not the shell
JQ_TIME='def epoch: if type == "number" then . elif test("^[0-9]+$") then tonumber else sub("\\.[0-9]+"; "") | fromdateiso8601 end;
def ago: (now - .) as $s | if $s < 60 then "przed chwilą" elif $s < 3600 then "\($s / 60 | floor) min temu"
  elif $s < 86400 then "\($s / 3600 | floor) godz. temu" elif $s < 172800 then "1 dzień temu" else "\($s / 86400 | floor) dni temu" end;
def local_clock: epoch | strflocaltime("%H:%M");
def local_when: epoch as $t | (if ($t | strflocaltime("%Y%m%d")) == (now | strflocaltime("%Y%m%d")) then ($t | strflocaltime("%H:%M"))
  else ($t | strflocaltime("%d.%m.%Y %H:%M")) end) + ", " + ($t | ago);'
# tjq [jq args]: jq with the time definitions above, in the server's zone.
tjq() { local filter="${*: -1}"; TZ="$(server_tz)" jq "${@:1:$#-1}" "$JQ_TIME $filter"; }
# shellcheck disable=SC2016 # jq variables
local_time_text() { tjq -rn --arg t "$1" '$t | local_when' 2>/dev/null || printf '%s' "$1"; }
# shellcheck disable=SC2016 # jq variables
local_clock_text() { tjq -rn --arg t "$1" '$t | local_clock' 2>/dev/null || printf '%s' "$1"; }
api_port() { local port; port="$(env_get MELLIS_API_PORT)"; printf '%s' "${port:-4100}"; }

# Compose's progress lines ("[+] Running 2/3 …") never reach the installer's screen: `--progress quiet` when this
# compose knows it (checked once), else they go to state/compose.log and only a failure shows its last lines.
COMPOSE_QUIET=""
compose_quiet() {
  if [ -z "$COMPOSE_QUIET" ]; then
    if docker compose --help 2>/dev/null | grep -e '--progress' | grep -q 'quiet'; then COMPOSE_QUIET=1; else COMPOSE_QUIET=0; fi
  fi
  [ "$COMPOSE_QUIET" = 1 ]
}

# dc <compose command>: the mellis project only. Never reads this script's stdin (answers piped into the installer
# stay for its questions) except `exec`, whose callers pass </dev/null unless they feed it a file (pg_restore).
dc() {
  local base=(docker compose --project-name mellis --project-directory "$MELLIS_ROOT" -f "$MELLIS_ROOT/docker-compose.yml" --env-file "$ENV_FILE")
  case "${1:-}" in
    exec) "${base[@]}" "$@" ;;
    up|stop|run|down|pull)
      if compose_quiet; then "${base[@]}" --progress quiet "$@" </dev/null; return; fi
      local log="$STATE_DIR/compose.log" status=0
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      "${base[@]}" "$@" </dev/null 2>>"$log" || status=$?
      if [ "$status" != 0 ]; then
        tail -n 20 "$log" 2>/dev/null | grep -Ev '^[[:space:]]*(\[\+\]|✔|⠿|Container |Network |Volume |Image )' >&2 || true
      fi
      return "$status" ;;
    *) "${base[@]}" "$@" </dev/null ;;
  esac
}

# admin <command> [args] [-- VAR...]: the compiled mellis-admin in a one-off api container (its .env, its volumes).
# Secrets are passed by name from this shell's environment (-e VAR), never on a command line.
admin() {
  local args=() passed=() seen_separator=0
  for arg in "$@"; do
    if [ "$seen_separator" = 1 ]; then passed+=(-e "$arg"); elif [ "$arg" = "--" ]; then seen_separator=1; else args+=("$arg"); fi
  done
  dc run --rm --no-deps -T "${passed[@]+"${passed[@]}"}" api node "$ADMIN_CLI" "${args[@]}" </dev/null
}

# The answer's JSON line (the CLI prints exactly one; pulls and warnings before it are ignored).
admin_json() { admin "$@" 2>/dev/null | grep '^{' | tail -n 1; }

# api_call METHOD PATH [JSON body]: the local API with the setup code. Sets API_STATUS and API_BODY (so never call it
# in a pipeline: that would run it in a subshell). Header and body go through files (chmod 600), never the command line.
API_STATUS=""
API_BODY=""
api_call() {
  local method="$1" path="$2" body="${3:-}" header_file body_file request_file
  header_file="$(mktemp)"; body_file="$(mktemp)"; request_file="$(mktemp)"
  chmod 600 "$header_file" "$request_file"
  printf 'X-Mellis-Setup-Code: %s\nContent-Type: application/json\n' "$(env_get SETUP_CODE)" > "$header_file"
  if [ "$method" = "GET" ]; then
    API_STATUS="$(curl -s -o "$body_file" -w '%{http_code}' -H "@$header_file" "http://127.0.0.1:$(api_port)$path" 2>/dev/null || true)"
  else
    printf '%s' "$body" > "$request_file"
    API_STATUS="$(curl -s -o "$body_file" -w '%{http_code}' -X "$method" -H "@$header_file" --data-binary "@$request_file" "http://127.0.0.1:$(api_port)$path" 2>/dev/null || true)"
  fi
  API_BODY="$(cat "$body_file")"
  rm -f "$header_file" "$body_file" "$request_file"
}

api_code() { printf '%s' "$API_BODY" | jq -r '.code // empty' 2>/dev/null || true; }

wait_for_postgres() {
  local waited=0
  until dc exec -T postgres pg_isready -U glucomind -d glucomind </dev/null >/dev/null 2>&1; do
    waited=$((waited + (MELLIS_SLEEP > 0 ? MELLIS_SLEEP : 1)))
    [ "$waited" -gt "$MELLIS_WAIT_SECONDS" ] && return 1
    pause
  done
}

local_app_config() { curl -fsS -m 5 "http://127.0.0.1:$(api_port)/v1/app-config" 2>/dev/null || true; }

container_of() { dc ps -aq "$1" 2>/dev/null | head -n 1; }

# wait_for_server VERSION: migrate exited 0, the API answers with VERSION, the worker keeps running.
wait_for_server() {
  local expected="$1" waited=0 answered="" cid code
  while :; do
    answered="$(local_app_config | jq -r '.server.version // empty' 2>/dev/null || true)"
    [ "$answered" = "$expected" ] && break
    cid="$(container_of migrate)"
    if [ -n "$cid" ]; then
      code="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$cid" 2>/dev/null || true)"
      if [ "${code%% *}" = "exited" ] && [ "${code##* }" != "0" ]; then err "Aktualizacja bazy (migrate) się nie udała."; return 1; fi
    fi
    waited=$((waited + (MELLIS_SLEEP > 0 ? MELLIS_SLEEP : 1)))
    if [ "$waited" -gt "$MELLIS_WAIT_SECONDS" ]; then err "Serwer nie odpowiada (oczekiwano wersji $expected, jest: ${answered:-brak odpowiedzi})."; return 1; fi
    pause
  done
  worker_running || { err "Proces w tle (worker) nie działa."; return 1; }
  pause
  worker_running || { err "Proces w tle (worker) się zatrzymał."; return 1; }
}

worker_running() {
  local cid
  cid="$(container_of worker)"
  [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)" = "running" ]
}

ensure_tools() {
  local missing=()
  for tool in curl jq openssl tar gzip; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  command -v qrencode >/dev/null 2>&1 || missing+=("qrencode")
  [ "${#missing[@]}" -eq 0 ] && return 0
  if command -v apt-get >/dev/null 2>&1; then
    say "Instaluję potrzebne drobne programy: ${missing[*]}"
    if ! { DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null; }; then
      warn "Nie udało się zainstalować: ${missing[*]}"
    fi
  fi
  for tool in curl jq tar; do command -v "$tool" >/dev/null 2>&1 || die "Brakuje programu $tool."; done
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker: $(docker --version | sed 's/,.*//')"
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    warn "Docker jest, ale bez „docker compose” (wersja 2)."
  else
    say "Docker nie jest zainstalowany. Mellis działa w kontenerach Dockera (to samo co Nightscout na wielu serwerach)."
  fi
  ask_yes "Zainstalować Dockera teraz (z oficjalnego repozytorium Dockera)?" t || die "Bez Dockera Mellis nie zadziała. Zainstaluj go i uruchom instalator ponownie."
  # shellcheck disable=SC1090
  . "$MELLIS_OS_RELEASE"
  local distro="${ID:-ubuntu}" codename="${VERSION_CODENAME:-}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$distro" "$codename" > /etc/apt/sources.list.d/docker.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker się nie zainstalował. Spróbuj ponownie albo zainstaluj go ręcznie."
  ok "Docker zainstalowany."
}

# The compose file, Caddyfile and this tool of a release: from the image itself (they always match it), or from a
# checkout (MELLIS_KIT_DIR, development and tests).
fetch_kit() {
  local version="$1" dest="$2" cid
  mkdir -p "$dest"
  if [ -n "${MELLIS_KIT_DIR:-}" ]; then
    cp "$MELLIS_KIT_DIR/deploy/docker-compose.yml" "$MELLIS_KIT_DIR/deploy/Caddyfile" "$dest/"
    cp "$MELLIS_KIT_DIR/scripts/install-server.sh" "$dest/mellis"
    return 0
  fi
  # MELLIS_LOCAL_IMAGE=1: an image built on this server (a fork, an offline install, a rehearsal before a release is
  # published) is used as it is, without a pull.
  if [ "${MELLIS_LOCAL_IMAGE:-}" = "1" ] && docker image inspect "$(image_name):$version" >/dev/null 2>&1; then
    say "Używam obrazu $(image_name):$version zbudowanego na tym serwerze."
  else
    say "Pobieram Mellisa $version…"
    docker pull -q "$(image_name):$version" >/dev/null || die "Nie udało się pobrać obrazu $(image_name):$version. Sprawdź połączenie z internetem."
  fi
  cid="$(docker create "$(image_name):$version")"
  docker cp "$cid:/app/server-kit/." "$dest/" >/dev/null
  docker rm "$cid" >/dev/null
}

install_kit() {
  local version="$1" kit
  kit="$(mktemp -d)"
  fetch_kit "$version" "$kit"
  cp "$kit/docker-compose.yml" "$kit/Caddyfile" "$MELLIS_ROOT/"
  install -m 0755 "$kit/mellis" "$MELLIS_ROOT/mellis"
  rm -rf "$kit"
}

install_command() {
  mkdir -p "$MELLIS_BIN_DIR"
  ln -sf "$MELLIS_ROOT/mellis" "$MELLIS_BIN_DIR/mellis"
  mkdir -p "$(dirname "$MELLIS_CRON_FILE")"
  cat > "$MELLIS_CRON_FILE" <<CRON
# Mellis (scripts/install-server.sh): nightly backup, daily check for a new release. Removed by: mellis → Odinstaluj.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root $MELLIS_BIN_DIR/mellis backup --cron >> $BACKUP_DIR/backup.log 2>&1
30 4 * * * root $MELLIS_BIN_DIR/mellis check-update --cron >/dev/null 2>&1
CRON
  chmod 644 "$MELLIS_CRON_FILE"
}

prepare_dirs() {
  mkdir -p "$MELLIS_ROOT" "$STATE_DIR" "$BACKUP_DIR" "$MELLIS_ROOT/secrets" "$MELLIS_ROOT/data/ai" "$MELLIS_ROOT/data/photos"
  chmod 700 "$MELLIS_ROOT" "$STATE_DIR" "$BACKUP_DIR" "$MELLIS_ROOT/secrets"
  # The containers run as node (uid 1000).
  chown 1000:1000 "$MELLIS_ROOT/data/ai" "$MELLIS_ROOT/data/photos" 2>/dev/null || true
  # Until the real key is pasted, an empty file keeps the compose mount valid (PUSH_PROVIDER=fake meanwhile).
  [ -e "$MELLIS_ROOT/secrets/apns.p8" ] || : > "$MELLIS_ROOT/secrets/apns.p8"
}

# Everything the worker needs to start with a paid provider, except the answers to the questions. Kept on a rerun.
write_base_env() {
  local version="$1"
  umask 077
  [ -f "$ENV_FILE" ] || printf '# Mellis server settings (scripts/install-server.sh). chmod 600: keys live only here.\n# Change them with: mellis → Zmień ustawienia.\n' > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  local zone
  zone="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  [ -z "$zone" ] || [ "$zone" = "Etc/UTC" ] || [ "$zone" = "UTC" ] && zone="Europe/Warsaw"
  set_default() { [ -n "$(env_get "$1")" ] || env_set "$1" "$2"; }
  env_set MELLIS_VERSION "$version"
  set_default MELLIS_SERVER_ID "$(random_hex 8)"
  set_default TZ "$zone"
  set_default POSTGRES_PASSWORD "$(random_hex 32)"
  set_default AUTH_MODE device
  set_default SETUP_CODE "$(random_code 4)"
  set_default NIGHTSCOUT_TOKEN_ENCRYPTION_KEY "$(random_hex 32)"
  set_default NIGHTSCOUT_SYNC_ENABLED true
  set_default NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES 24
  set_default API_PORT 3000
  set_default MELLIS_API_PORT "$(free_port 4100)"
  set_default API_PUBLISH "127.0.0.1:$(env_get MELLIS_API_PORT)"
  set_default COMPOSE_PROFILES ""
  set_default PUBLIC_BASE_URL ""
  set_default DOMAIN "localhost"
  # Features the user docs describe; each one is still switched per patient / person / phone in the app.
  set_default REMOTE_COMMANDS_ENABLED true
  set_default AI_ENABLE_MEAL_ACTIONS 1
  set_default AI_ENABLE_BOLUS_PROPOSALS 1
  set_default RESCUE_CARB_ALERTS_ENABLED 1
  set_default AI_ENABLE_TIME_RANGE_GLUCOSE_TOOL_CALLING 1
  # Knowledge search: off until build_knowledge has indexed the shipped knowledge base (then 1).
  set_default AI_ENABLE_KNOWLEDGE_SEARCH 0
  set_default BETA_ALLOWLIST_ENABLED false
  # AI: fake (nothing paid) until the key is checked.
  set_default AI_PROVIDER fake
  set_default AI_BUDGETED_USAGE_SESSION true
  set_default AI_LEDGER_FILE ai-usage-ledger.json
  set_default AI_EXPERIMENT_COST_CURRENCY USD
  set_default OPENAI_EVAL_CAPTURE_ENABLED false
  set_default PUSH_PROVIDER fake
}

# Prices and limits per provider (the worker refuses to start a paid provider without them).
write_ai_env() {
  local provider="$1" anthropic_key="$2" openai_key="$3"
  env_set AI_PROVIDER "$provider"
  env_set ANTHROPIC_API_KEY "$anthropic_key"
  env_set OPENAI_API_KEY "$openai_key"
  env_set OPENAI_TIMEOUT_MS 90000
  env_set OPENAI_MODEL gpt-5.6-terra
  env_set OPENAI_PRICING_INPUT_PER_1K_TOKENS 0.002
  env_set OPENAI_PRICING_CACHED_INPUT_PER_1K_TOKENS 0.0002
  env_set OPENAI_PRICING_OUTPUT_PER_1K_TOKENS 0.012
  env_set OPENAI_PRICING_REASONING_PER_1K_TOKENS 0
  env_set OPENAI_PRICING_CURRENCY USD
  env_set OPENAI_PRICING_VERSION openai.gpt-5.6-terra.2026-10
  env_set OPENAI_LIGHT_MODEL gpt-5.6-luna
  env_set OPENAI_LIGHT_PRICING_INPUT_PER_1K_TOKENS 0.0002
  env_set OPENAI_LIGHT_PRICING_CACHED_INPUT_PER_1K_TOKENS 0.00002
  env_set OPENAI_LIGHT_PRICING_OUTPUT_PER_1K_TOKENS 0.0012
  env_set OPENAI_LIGHT_PRICING_REASONING_PER_1K_TOKENS 0
  env_set OPENAI_LIGHT_PRICING_CURRENCY USD
  env_set OPENAI_LIGHT_PRICING_VERSION openai.gpt-5.6-luna.2026-10
  env_set OPENAI_EMBEDDING_PRICING_INPUT_PER_1K_TOKENS 0.00002
  env_set OPENAI_EMBEDDING_PRICING_VERSION text-embedding-3-small-2026-10
  env_set ANTHROPIC_MODEL claude-opus-5-5
  env_set ANTHROPIC_REFUSAL_FALLBACK true
  env_set ANTHROPIC_PRICING_INPUT_PER_1K_TOKENS 0.004
  env_set ANTHROPIC_PRICING_CACHED_INPUT_PER_1K_TOKENS 0.0002
  env_set ANTHROPIC_PRICING_OUTPUT_PER_1K_TOKENS 0.02
  env_set ANTHROPIC_PRICING_REASONING_PER_1K_TOKENS 0
  env_set ANTHROPIC_PRICING_CURRENCY USD
  env_set ANTHROPIC_PRICING_VERSION anthropic.claude-opus-5-5.2026-10
  if [ "$provider" = "anthropic" ]; then
    # Claude thinks inside the output limit: bigger calls than OpenAI's.
    env_set AI_EXPERIMENT_MAX_COST 1
    env_set AI_EXPERIMENT_MAX_OUTPUT_TOKENS 8000
  else
    env_set AI_EXPERIMENT_MAX_COST 0.25
    env_set AI_EXPERIMENT_MAX_OUTPUT_TOKENS 4000
  fi
  # Voice on the server only with an OpenAI key; otherwise the phone transcribes (Apple Speech).
  if [ -n "$openai_key" ]; then
    env_set VOICE_TRANSCRIPTION_ENABLED 1
    env_set OPENAI_TRANSCRIPTION_MODEL gpt-transcribe
    env_set OPENAI_TRANSCRIPTION_PRICING_PER_MINUTE 0.0045
    env_set OPENAI_TRANSCRIPTION_PRICING_VERSION openai.gpt-transcribe.2026-10
  else
    env_set VOICE_TRANSCRIPTION_ENABLED 0
  fi
}

free_port() {
  local port="$1"
  while port_in_use "$port"; do port=$((port + 1)); done
  printf '%s' "$port"
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$"
  else
    return 1
  fi
}

# --------------------------------------------------------------------------------------------------------------------
# Checks before anything is installed
# --------------------------------------------------------------------------------------------------------------------

nightscout_on_host() {
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -qi 'nightscout\|cgm-remote-monitor\|ns-server'; then return 0; fi
  port_in_use 1337
}

has_public_ipv4() {
  command -v ip >/dev/null 2>&1 || return 0
  ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
    | grep -Ev '^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' | grep -q .
}

looks_like_mikrus() {
  hostname 2>/dev/null | grep -qi 'mikr' && return 0
  grep -qis 'mikr\.us\|mikrus' /etc/motd /etc/issue 2>/dev/null && return 0
  [ -e /klucz_api ]
}

preflight() {
  title "Sprawdzam serwer"
  if [ -f "$MELLIS_OS_RELEASE" ]; then
    # shellcheck disable=SC1090
    . "$MELLIS_OS_RELEASE"
    case "${ID:-}-${VERSION_ID:-}" in
      ubuntu-24.04|ubuntu-22.04|debian-12) ok "System: ${PRETTY_NAME:-$ID $VERSION_ID}" ;;
      ubuntu-*|debian-*) warn "System ${PRETTY_NAME:-$ID $VERSION_ID}: sprawdzone są Ubuntu 24.04 i 22.04 oraz Debian 12, ale powinno działać." ;;
      *) warn "System ${PRETTY_NAME:-nieznany}: instalator jest dla Ubuntu 24.04 i Debiana 12."; ask_yes "Kontynuować mimo to?" n || exit 1 ;;
    esac
  fi
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "Procesor $(uname -m) nie jest obsługiwany (potrzebny 64-bitowy x86 albo ARM)." ;;
  esac

  local mem_kb mem_mb need_mb=900 nightscout=0
  mem_kb="$(awk '/^MemTotal:/ {print $2}' "$MELLIS_MEMINFO" 2>/dev/null || echo 0)"
  mem_mb=$((mem_kb / 1024))
  if nightscout_on_host; then nightscout=1; need_mb=1800; fi
  if [ "$mem_mb" -lt "$need_mb" ]; then
    if [ "$nightscout" = 1 ]; then
      die "Za mało pamięci RAM: ${mem_mb} MB. Mellis razem z Nightscoutem potrzebuje planu z 2 GB RAM. Wybierz większy plan albo przenieś Nightscouta na osobny serwer."
    fi
    die "Za mało pamięci RAM: ${mem_mb} MB. Mellis potrzebuje planu z co najmniej 1 GB RAM."
  fi
  ok "Pamięć: ${mem_mb} MB"
  [ "$nightscout" = 1 ] && ok "Na tym serwerze działa też Nightscout: Mellis go nie ruszy."

  local free_kb free_gb
  mkdir -p "$(dirname "$MELLIS_ROOT")"
  free_kb="$(df -Pk "$(dirname "$MELLIS_ROOT")" | awk 'NR == 2 {print $4}')"
  free_gb=$((free_kb / 1024 / 1024))
  [ "$free_kb" -lt $((3 * 1024 * 1024)) ] && die "Za mało miejsca na dysku: ${free_gb} GB wolne, potrzeba co najmniej 3 GB."
  ok "Dysk: ${free_gb} GB wolne"
  if has_public_ipv4; then
    PREFLIGHT_PUBLIC_IPV4=1
SETUP_OPEN=0
  else
    PREFLIGHT_PUBLIC_IPV4=0
    if looks_like_mikrus; then ok "Mikrus bez własnego IPv4: adres ustawisz w panelu Mikrusa (instalator powie jak)."; else hint "Serwer bez publicznego IPv4: przy adresie wybierz subdomenę Mikrusa albo Cloudflare Tunnel."; fi
  fi
}
PREFLIGHT_PUBLIC_IPV4=1

# --------------------------------------------------------------------------------------------------------------------
# Questions (installer and "Zmień ustawienia")
# --------------------------------------------------------------------------------------------------------------------

nightscout_error_text() {
  case "$1" in
    NIGHTSCOUT_ADDRESS_INVALID) printf 'to nie wygląda na adres Nightscouta (np. https://moj-nightscout.example.pl).' ;;
    NIGHTSCOUT_HOST_NOT_ALLOWED|NIGHTSCOUT_UNREACHABLE) printf 'sprawdź, czy adres otwiera się w przeglądarce. Adres musi być publiczny: Nightscout dostępny tylko w sieci domowej nie zadziała.' ;;
    NIGHTSCOUT_TOKEN_MISSING) printf 'brak tokenu.' ;;
    NIGHTSCOUT_TOKEN_INVALID) printf 'token nie działa. Skopiuj go jeszcze raz w całości (Admin Tools → Subjects → Access Token).' ;;
    NIGHTSCOUT_TOKEN_ADMIN|NIGHTSCOUT_TOKEN_NOT_READ_ONLY) printf 'ten token ma prawo zapisu. Mellis tylko czyta z Nightscouta: zrób token z rolą readable.' ;;
    NIGHTSCOUT_NO_RECENT_READINGS) printf 'w Nightscoucie nie ma odczytu glukozy z ostatnich 24 godzin.' ;;
    NIGHTSCOUT_ALREADY_USED) printf 'ten Nightscout jest już połączony z innym podopiecznym na tym serwerze.' ;;
    *) printf '%s' "${1:-brak odpowiedzi serwera}" ;;
  esac
}

# "✓ Połączono. Ostatni odczyt: 142 mg/dL, 2 min temu. Pętla: Trio 0.5." from { nightscout: {...} }.
print_nightscout_ok() {
  local json="$1" value age loop
  value="$(printf '%s' "$json" | jq -r '.nightscout.last_reading.value // empty')"
  age="$(printf '%s' "$json" | jq -r '.nightscout.last_reading.age_minutes // empty')"
  loop="$(printf '%s' "$json" | jq -r '.nightscout.uploader // empty')"
  ok "Połączono. Ostatni odczyt: ${value} mg/dL, ${age} min temu.${loop:+ Pętla: $loop.}"
}

# Asks the address and the read-only token; a link with ?token= is split. Sets NS_URL and NS_TOKEN.
NS_URL=""
NS_TOKEN=""
read_nightscout() {
  local default_url="${1:-}" url token
  ask url "Adres Nightscouta" "$default_url"
  [ -z "$url" ] && { warn "Wpisz adres Nightscouta."; return 1; }
  case "$url" in http://*|https://*) ;; *) url="https://$url" ;; esac
  token=""
  if [[ "$url" == *"token="* ]]; then
    token="$(printf '%s' "$url" | sed -n 's/.*[?&]token=\([^&#]*\).*/\1/p')"
    url="$(printf '%s' "$url" | sed 's/[?&]token=[^&#]*//; s/[?]$//; s/[?]&/?/')"
    ok "Token odczytany z linku."
  fi
  url="${url%/}"
  if [ -z "$token" ]; then
    hint "Jak zrobić token: ${KEYS_DOC}#token-nightscouta"
    ask_secret token "Token (tylko do odczytu)"
  fi
  NS_URL="$url"
  NS_TOKEN="$token"
}

# Fresh setup: the API's own test (nothing stored yet).
ask_nightscout_setup() {
  local attempts=0
  while :; do
    attempts=$((attempts + 1))
    [ "$attempts" -gt 5 ] && die "Nie udało się połączyć z Nightscoutem. Sprawdź adres i token i uruchom instalator ponownie."
    read_nightscout || continue
    api_call POST /v1/setup/nightscout-check "$(printf '{"url":%s,"token":%s}' "$(json_str "$NS_URL")" "$(json_str "$NS_TOKEN")")"
    if [ "$API_STATUS" = "200" ]; then print_nightscout_ok "$API_BODY"; return 0; fi
    err "Nie udało się połączyć z Nightscoutem: $(nightscout_error_text "$(api_code)")"
  done
}

# An existing patient (restore, "Zmień ustawienia → Nightscout"): tested and stored by the server CLI.
set_patient_nightscout() {
  local patient_id="$1" name="$2" default_url="${3:-}" attempts=0 answer code
  while :; do
    attempts=$((attempts + 1))
    [ "$attempts" -gt 5 ] && { err "Nightscout dla: $name nie został zapisany. Zmienisz go później: mellis → Zmień ustawienia → Nightscout."; return 1; }
    read_nightscout "$default_url" || continue
    answer="$(MELLIS_NIGHTSCOUT_URL="$NS_URL" MELLIS_NIGHTSCOUT_TOKEN="$NS_TOKEN" admin_json set-nightscout --patient "$patient_id" -- MELLIS_NIGHTSCOUT_URL MELLIS_NIGHTSCOUT_TOKEN || true)"
    if printf '%s' "$answer" | jq -e '.nightscout' >/dev/null 2>&1; then print_nightscout_ok "$answer"; return 0; fi
    code="$(printf '%s' "$answer" | jq -r '.error // empty' 2>/dev/null || true)"
    err "Nie udało się połączyć z Nightscoutem: $(nightscout_error_text "$code")"
  done
}

ask_birth_year() {
  local __var="$1" __year __current
  __current="$(date +%Y)"
  while :; do
    ask __year "Rok urodzenia"
    if [[ "$__year" =~ ^[0-9]{4}$ ]] && [ "$__year" -ge 1900 ] && [ "$__year" -le "$__current" ]; then break; fi
    warn "Wpisz rok, np. 2016."
  done
  printf -v "$__var" '%s' "$__year"
}

# One patient of a fresh setup: Nightscout first (tested at once), then the name and the year of birth.
add_setup_patient() {
  local name year attempts=0
  while :; do
    ask name "Imię"
    [ -n "$name" ] && break
    warn "Wpisz imię."
  done
  ask_birth_year year
  say "Nightscout dla: ${C_BOLD}$name${C_OFF}"
  ask_nightscout_setup
  while :; do
    attempts=$((attempts + 1))
    api_call POST /v1/setup/patients "$(printf '{"display_name":%s,"birth_year":%s,"nightscout":{"url":%s,"token":%s}}' \
      "$(json_str "$name")" "$year" "$(json_str "$NS_URL")" "$(json_str "$NS_TOKEN")")"
    if [ "$API_STATUS" = "201" ]; then ok "Dodano: $name ($year)."; return 0; fi
    case "$(api_code)" in
      NIGHTSCOUT_*) err "Nie udało się połączyć z Nightscoutem: $(nightscout_error_text "$(api_code)")"; ask_nightscout_setup ;;
      *) err "Serwer nie zapisał podopiecznego: $(printf '%s' "$API_BODY" | jq -r '.title // .code // empty' 2>/dev/null)"; [ "$attempts" -ge 3 ] && die "Spróbuj uruchomić instalator ponownie." ;;
    esac
  done
}

ai_key_error_text() {
  case "$1" in
    *AI_KEY_INVALID*) printf 'Klucz AI nie działa. Sprawdź, czy na koncie dostawcy są środki (Billing), i skopiuj klucz jeszcze raz, bez spacji.' ;;
    *AI_KEY_UNREACHABLE*) printf 'Nie udało się połączyć z dostawcą AI. Sprawdź połączenie serwera z internetem i spróbuj ponownie.' ;;
    *AI_KEY_MISSING*) printf 'Brak klucza.' ;;
    *) printf 'Klucz AI nie działa (%s).' "$1" ;;
  esac
}

# "Kto ma odpowiadać…" + the key(s), each checked with a free model-list call; then the monthly limit.
ask_ai() {
  local choice provider anthropic_key="" openai_key="" answer error default_choice=1 main_key
  [ "$(env_get AI_PROVIDER)" = "anthropic" ] && default_choice=2
  choose choice "Kto ma odpowiadać: OpenAI (polecany) czy Anthropic?" "$default_choice" "OpenAI (polecany)" "Anthropic"
  if [ "$choice" = 1 ]; then provider=openai; else provider=anthropic; fi
  hint "Skąd wziąć klucz: ${KEYS_DOC}#klucz-ai"
  while :; do
    if [ "$provider" = "openai" ]; then
      ask_secret openai_key "Klucz OpenAI (zaczyna się od sk-)"
      anthropic_key=""
    else
      ask_secret anthropic_key "Klucz Anthropic (zaczyna się od sk-ant-)"
      say "Opcjonalnie klucz OpenAI: lepsze wyszukiwanie w bazie wiedzy i rozpoznawanie mowy na serwerze, koszt to grosze"
      say "miesięcznie. Enter pomija: wyszukiwanie po słowach, mowa rozpoznawana na telefonie."
      ask_secret openai_key "Klucz OpenAI (opcjonalnie)"
    fi
    if [ "${SETUP_OPEN:-0}" = 1 ]; then
      # The setup API's own check (keys in the request body, never on a command line).
      if [ "$provider" = "openai" ]; then main_key="$openai_key"; else main_key="$anthropic_key"; fi
      api_call POST /v1/setup/ai "$(printf '{"provider":%s,"api_key":%s%s}' "$(json_str "$provider")" "$(json_str "$main_key")" \
        "$([ "$provider" = anthropic ] && [ -n "$openai_key" ] && printf ',"openai_api_key":%s' "$(json_str "$openai_key")")")"
      if [ "$API_STATUS" = "200" ]; then answer='{"ok":true}'; else answer="{\"ok\":false,\"error\":$(json_str "$(printf '%s' "$API_BODY" | jq -r '.title // .code // empty' 2>/dev/null)")}"; fi
    else
      answer="$(AI_PROVIDER="$provider" ANTHROPIC_API_KEY="$anthropic_key" OPENAI_API_KEY="$openai_key" admin_json check-ai -- AI_PROVIDER ANTHROPIC_API_KEY OPENAI_API_KEY || true)"
    fi
    if printf '%s' "$answer" | jq -e '.ok == true' >/dev/null 2>&1; then
      if [ "$provider" = "openai" ]; then ok "Klucz OpenAI działa."; else ok "Klucz Anthropic działa.${openai_key:+ Klucz OpenAI też.}"; fi
      break
    fi
    error="$(printf '%s' "$answer" | jq -r '.error // empty' 2>/dev/null || true)"
    err "$(ai_key_error_text "${error:-brak odpowiedzi}")${error:+ ($(printf '%s' "$error" | sed 's/.*: //'))}"
  done
  write_ai_env "$provider" "$anthropic_key" "$openai_key"
  ask_ai_limit
}

ask_ai_limit() {
  local limit default
  default="$(env_get AI_MONTHLY_LIMIT_USD)"
  while :; do
    ask limit "Miesięczny limit wydatków na AI w USD" "${default:-15}"
    limit="${limit/,/.}"
    if [[ "$limit" =~ ^[0-9]+([.][0-9]{1,2})?$ ]] && [ "$(awk -v l="$limit" 'BEGIN { print (l > 0) ? 1 : 0 }')" = 1 ]; then break; fi
    warn "Wpisz kwotę w USD, np. 15."
  done
  env_set AI_MONTHLY_LIMIT_USD "$limit"
  hint "Po przekroczeniu limitu AI przestaje odpowiadać do końca miesiąca, a reszta aplikacji działa dalej."
}

# The ledger the worker reserves in, monthly, with the limit from .env (created or changed, spending kept).
apply_ai_limit() {
  local limit answer
  limit="$(env_get AI_MONTHLY_LIMIT_USD)"
  [ -z "$limit" ] && return 0
  answer="$(admin_json ai-limit --total "$limit" || true)"
  if printf '%s' "$answer" | jq -e '.period == "MONTHLY"' >/dev/null 2>&1; then
    ok "Limit AI: $limit USD miesięcznie (wydano w tym miesiącu: $(printf '%s' "$answer" | jq -r '.charged') USD)."
  else
    err "Nie udało się ustawić limitu AI: $(printf '%s' "$answer" | jq -r '.error // empty' 2>/dev/null)"
    return 1
  fi
}

# Key ID, Team ID and the pasted .p8 (read up to the END PRIVATE KEY line).
ask_apns() {
  local key_id team_id line p8="" begun=0 tmp
  hint "Skąd wziąć Key ID, Team ID i plik .p8: ${KEYS_DOC}#klucz-apns"
  while :; do
    ask key_id "Key ID klucza APNs (10 znaków z nazwy pliku AuthKey_XXXXXXXXXX.p8)" "$(env_get APNS_KEY_ID)"
    key_id="$(printf '%s' "$key_id" | tr '[:lower:]' '[:upper:]' | sed 's/^AUTHKEY_//; s/\.P8$//')"
    [[ "$key_id" =~ ^[A-Z0-9]{10}$ ]] && break
    warn "Key ID ma 10 znaków (litery i cyfry)."
  done
  while :; do
    ask team_id "Team ID (konto Apple Developer, Membership details)" "$(env_get APNS_TEAM_ID)"
    team_id="$(printf '%s' "$team_id" | tr '[:lower:]' '[:upper:]')"
    [[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] && break
    warn "Team ID ma 10 znaków (litery i cyfry)."
  done
  while :; do
    say "Wklej całą zawartość pliku .p8, razem z liniami -----BEGIN PRIVATE KEY----- i -----END PRIVATE KEY-----:"
    p8=""; begun=0
    while IFS= read -r line; do
      line="${line%$'\r'}"
      line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      [ -z "$line" ] && [ "$begun" = 0 ] && continue
      [[ "$line" == *"BEGIN PRIVATE KEY"* ]] && begun=1
      [ "$begun" = 1 ] && p8+="$line"$'\n'
      [[ "$line" == *"END PRIVATE KEY"* ]] && break
    done
    if [[ "$p8" == *"BEGIN PRIVATE KEY"* && "$p8" == *"END PRIVATE KEY"* ]]; then
      tmp="$(mktemp)"; chmod 600 "$tmp"; printf '%s' "$p8" > "$tmp"
      if ! command -v openssl >/dev/null 2>&1 || openssl pkey -in "$tmp" -noout >/dev/null 2>&1; then
        install -m 0400 "$tmp" "$MELLIS_ROOT/secrets/apns.p8"
        chown 1000:1000 "$MELLIS_ROOT/secrets/apns.p8" 2>/dev/null || true
        rm -f "$tmp"
        break
      fi
      rm -f "$tmp"
    fi
    err "To nie jest cały klucz .p8. Otwórz plik w TextEdit, skopiuj wszystko (⌘A, ⌘C) i wklej ponownie."
    [ -t 0 ] || die "Nie udało się odczytać klucza .p8."
  done
  env_set PUSH_PROVIDER apns
  env_set APNS_KEY_ID "$key_id"
  env_set APNS_TEAM_ID "$team_id"
  # One family = one Team ID = one bundle ID (install-app.sh builds pl.mellis.<TeamID>); the APNs host is found per
  # token, and apps built in Xcode use the sandbox.
  env_set APNS_BUNDLE_ID "pl.mellis.$team_id"
  env_set APNS_USE_SANDBOX true
  env_set APNS_TIMEOUT_MS 10000
  ok "Klucz APNs zapisany."
}

public_url_works() {
  local url="$1"
  curl -fsS -m 10 "$url/v1/app-config" 2>/dev/null | jq -e '.server' >/dev/null 2>&1
}

# Waits for the address to answer (a certificate or a panel change can take a minute). 0 when it works.
wait_for_public_url() {
  local url="$1" waited=0
  while ! public_url_works "$url"; do
    waited=$((waited + (MELLIS_SLEEP > 0 ? MELLIS_SLEEP : 1)))
    [ "$waited" -gt "$MELLIS_WAIT_SECONDS" ] && return 1
    pause
  done
}

ufw_allow() {
  command -v ufw >/dev/null 2>&1 || return 0
  ufw status 2>/dev/null | grep -q '^Status: active' || return 0
  for rule in "$@"; do ufw allow "$rule" >/dev/null 2>&1 || true; done
}

# Own domain + Caddy, Mikrus subdomain, or Cloudflare Tunnel. Writes PUBLIC_BASE_URL, DOMAIN, COMPOSE_PROFILES,
# API_PUBLISH; the stack is (re)started by the caller. The Mikrus path starts the API itself (the panel checks the port).
ask_address() {
  local choice pick domain url token port answer order index labels=()
  # The way that fits this server is listed first (and is the default): 1 domain, 2 Mikrus subdomain, 3 Cloudflare Tunnel.
  if looks_like_mikrus; then order=(2 1 3); elif [ "$PREFLIGHT_PUBLIC_IPV4" = 0 ]; then order=(3 1 2); else order=(1 2 3); fi
  for index in "${order[@]}"; do
    case "$index" in
      1) labels+=("Własna domena albo subdomena (np. mellis.moja-domena.pl), HTTPS zrobi instalator") ;;
      2) labels+=("Subdomena Mikrusa (panel Mikrusa → Sieć i domeny → Subdomeny)") ;;
      3) labels+=("Cloudflare Tunnel (serwer w domu, bez otwierania portów)") ;;
    esac
  done
  labels[0]="${labels[0]} (polecane)"
  hint "Co wybrać i jak: ${MELLIS_DOCS}/instalacja/serwer/#odpowiedz-na-pytania"
  choose pick "Jak telefony mają łączyć się z serwerem?" 1 "${labels[@]}"
  choice="${order[$((pick - 1))]}"
  port="$(api_port)"
  case "$choice" in
    1)
      while :; do
        ask domain "Domena serwera (rekord A wskazuje na ten serwer)" "$(env_get DOMAIN | sed 's/^localhost$//')"
        domain="$(printf '%s' "$domain" | sed 's#^https\?://##; s#/.*$##' | tr '[:upper:]' '[:lower:]')"
        [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] && break
        warn "Wpisz samą nazwę, np. mellis.moja-domena.pl."
      done
      if dc ps -q caddy 2>/dev/null | grep -q .; then :; elif port_in_use 80 || port_in_use 443; then
        err "Porty 80 albo 443 zajmuje inny program (np. Nightscout z własnym certyfikatem)."
        say "Wybierz Cloudflare Tunnel albo subdomenę Mikrusa, albo zwolnij te porty i uruchom instalator ponownie."
        ask_address
        return
      fi
      if command -v getent >/dev/null 2>&1 && ! getent ahosts "$domain" >/dev/null 2>&1; then
        warn "Domena $domain jeszcze nie wskazuje na żaden adres. Zmiana w domenie potrzebuje do godziny."
      fi
      ufw_allow 80/tcp 443/tcp 443/udp
      env_set DOMAIN "$domain"
      env_set PUBLIC_BASE_URL "https://$domain"
      env_set COMPOSE_PROFILES caddy
      env_set API_PUBLISH "127.0.0.1:$port"
      env_set CLOUDFLARE_TUNNEL_TOKEN ""
      ;;
    2)
      env_set COMPOSE_PROFILES ""
      env_set DOMAIN localhost
      env_set API_PUBLISH "$port"
      env_set CLOUDFLARE_TUNNEL_TOKEN ""
      ufw_allow "$port/tcp"
      dc up -d api >/dev/null 2>&1 || true
      say ""
      say "Subdomenę ustawiasz w panelu Mikrusa (w przeglądarce), potem wklejasz tu jej adres:"
      say "  1. Otwórz panel Mikrusa → ${C_BOLD}Sieć i domeny → Subdomeny${C_OFF}."
      say "  2. Dodaj subdomenę: nazwa dowolna (np. mellis-ania), port: ${C_BOLD}$port${C_OFF}."
      say "  3. Panel pokaże jej adres, np. https://mellis-ania.mikrus.dev: skopiuj go."
      say "  4. Wklej go tutaj i naciśnij Enter."
      hint "Panel przyjmuje tylko port, który już odpowiada: Mellis odpowiada na porcie $port od teraz."
      while :; do
        ask url "Adres subdomeny z panelu Mikrusa (np. https://mellis-ania.mikrus.dev)" "$(env_get PUBLIC_BASE_URL)"
        [ -z "$url" ] && continue
        case "$url" in http://*) url="https://${url#http://}" ;; https://*) ;; *) url="https://$url" ;; esac
        url="${url%/}"
        say "Sprawdzam $url…"
        if wait_for_public_url "$url"; then ok "Adres działa."; break; fi
        err "Pod tym adresem jeszcze nie odpowiada Mellis. Sprawdź w panelu, czy subdomena wskazuje na port $port."
        ask answer "Enter = sprawdź jeszcze raz, p = pomiń na razie"
        if [ "$answer" = "p" ]; then break; fi
      done
      env_set PUBLIC_BASE_URL "$url"
      ;;
    3)
      say ""
      say "Cloudflare Tunnel: na dash.cloudflare.com → Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared)."
      say "W kroku „Install connector” wybierz Docker i skopiuj sam token (długi ciąg po --token)."
      say "W „Public Hostname” wpisz swoją subdomenę, a jako usługę: HTTP, adres ${C_BOLD}api:3000${C_OFF}."
      while :; do
        ask_secret token "Token tunelu"
        token="$(printf '%s' "$token" | sed 's/.*--token[[:space:]]*//')"
        [ "${#token}" -ge 20 ] && break
        warn "To nie wygląda na token tunelu."
      done
      while :; do
        ask domain "Adres z „Public Hostname” (np. mellis.moja-domena.pl)" "$(env_get PUBLIC_BASE_URL | sed 's#^https://##')"
        domain="$(printf '%s' "$domain" | sed 's#^https\?://##; s#/.*$##' | tr '[:upper:]' '[:lower:]')"
        [ -n "$domain" ] && break
      done
      env_set CLOUDFLARE_TUNNEL_TOKEN "$token"
      env_set COMPOSE_PROFILES tunnel
      env_set DOMAIN localhost
      env_set PUBLIC_BASE_URL "https://$domain"
      env_set API_PUBLISH "127.0.0.1:$port"
      ;;
  esac
}

# --------------------------------------------------------------------------------------------------------------------
# Backups
# --------------------------------------------------------------------------------------------------------------------

backup_files() { find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'mellis-*.tar.gz' \) 2>/dev/null | sort; }
latest_backup() { backup_files | tail -n 1; }

file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# When the file was written, in the server's zone: "03:00, 9 godz. temu".
backup_age_text() {
  local file="$1" mtime
  [ -z "$file" ] && { printf 'brak'; return; }
  mtime="$(file_mtime "$file")"
  [ -n "$mtime" ] && { local_time_text "$mtime"; return; }
  printf '%s' "$(basename "$file")"
}

# make_backup [label]: database, meal photos, AI ledger and the settings without keys, as one file. Prints its path.
make_backup() {
  local label="${1:-}" stamp tmp file version
  version="$(current_version)"
  stamp="$(TZ="$(server_tz)" date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  tmp="$(mktemp -d "$BACKUP_DIR/.tmp-XXXXXX")"
  dc up -d postgres >/dev/null 2>&1 || true
  wait_for_postgres || { rm -rf "$tmp"; err "Baza danych nie odpowiada."; return 1; }
  if ! dc exec -T postgres pg_dump -U glucomind -d glucomind -Fc </dev/null > "$tmp/database.dump"; then
    rm -rf "$tmp"; err "Kopia bazy się nie udała."; return 1
  fi
  mkdir -p "$tmp/photos" "$tmp/ai"
  cp -a "$MELLIS_ROOT/data/photos/." "$tmp/photos/" 2>/dev/null || true
  find "$MELLIS_ROOT/data/ai" -maxdepth 1 -name '*.json' -exec cp -a {} "$tmp/ai/" \; 2>/dev/null || true
  settings_without_keys "$ENV_FILE" > "$tmp/settings.env"
  printf 'format=mellis-backup-1\nversion=%s\ncreated_at=%s\nserver_id=%s\n' "$version" "$(date -u +%FT%TZ)" "$(env_get MELLIS_SERVER_ID)" > "$tmp/manifest.txt"
  file="$BACKUP_DIR/mellis-${version}-${stamp}${label:+-$label}.tar.gz"
  (umask 077; tar -C "$tmp" -czf "$file.part" .)
  mv "$file.part" "$file"
  chmod 600 "$file"
  rm -rf "$tmp"
  find "$BACKUP_DIR" -maxdepth 1 -name 'mellis-*.tar.gz' -mtime +"$BACKUP_KEEP_DAYS" -delete 2>/dev/null || true
  printf '%s\n' "$file"
}

backup_manifest() { tar -xzOf "$1" ./manifest.txt 2>/dev/null || tar -xzOf "$1" manifest.txt 2>/dev/null || true; }

# A plain pg_dump (custom format) from an older installation, e.g. the Cognito-era production's backup.sh.
is_raw_dump() { [ "$(head -c 5 "$1" 2>/dev/null)" = "PGDMP" ]; }

# restore_backup FILE: stops Mellis, replaces the database (and photos, ledger), migrates and starts again.
restore_backup() {
  local file="$1" tmp backup_version current
  [ -f "$file" ] || { err "Nie ma pliku: $file"; return 1; }
  tmp="$(mktemp -d "$MELLIS_ROOT/.restore-XXXXXX")"
  if is_raw_dump "$file"; then
    cp "$file" "$tmp/database.dump"
    backup_version=""
  else
    tar -C "$tmp" -xzf "$file" || { rm -rf "$tmp"; err "Ten plik nie jest kopią Mellisa."; return 1; }
    [ -f "$tmp/database.dump" ] || { rm -rf "$tmp"; err "W pliku nie ma kopii bazy."; return 1; }
    backup_version="$(sed -n 's/^version=//p' "$tmp/manifest.txt" 2>/dev/null)"
  fi
  current="$(current_version)"
  if [ -n "$backup_version" ] && version_gt "$backup_version" "$current"; then
    rm -rf "$tmp"
    err "Kopia pochodzi z nowszej wersji Mellisa ($backup_version) niż ta na serwerze ($current). Najpierw zaktualizuj: mellis update $backup_version"
    return 1
  fi
  say "Zatrzymuję Mellisa na czas przywracania…"
  dc stop api worker caddy cloudflared >/dev/null 2>&1 || true
  dc up -d postgres >/dev/null
  wait_for_postgres || { rm -rf "$tmp"; err "Baza danych nie odpowiada."; return 1; }
  dc exec -T postgres psql -q -U glucomind -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE IF EXISTS glucomind WITH (FORCE)' -c 'CREATE DATABASE glucomind OWNER glucomind' </dev/null >/dev/null
  if ! dc exec -T postgres pg_restore -U glucomind -d glucomind --no-owner --no-privileges --exit-on-error < "$tmp/database.dump"; then
    rm -rf "$tmp"; err "Przywracanie bazy się nie udało."; return 1
  fi
  if [ -d "$tmp/photos" ]; then
    find "$MELLIS_ROOT/data/photos" -mindepth 1 -delete 2>/dev/null || true
    cp -a "$tmp/photos/." "$MELLIS_ROOT/data/photos/"
  fi
  if [ -d "$tmp/ai" ] && ls "$tmp/ai"/*.json >/dev/null 2>&1; then
    rm -f "$MELLIS_ROOT"/data/ai/*.json "$MELLIS_ROOT"/data/ai/*.lock 2>/dev/null || true
    cp -a "$tmp/ai/"*.json "$MELLIS_ROOT/data/ai/"
  fi
  chown -R 1000:1000 "$MELLIS_ROOT/data" 2>/dev/null || true
  RESTORED_SERVER_ID="$(sed -n 's/^server_id=//p' "$tmp/manifest.txt" 2>/dev/null || true)"
  [ -f "$tmp/settings.env" ] && cp "$tmp/settings.env" "$STATE_DIR/restored-settings.env"
  rm -rf "$tmp"
  dc run --rm -T migrate </dev/null >/dev/null || { err "Aktualizacja przywróconej bazy (migrate) się nie udała."; return 1; }
  ok "Baza przywrócona."
}
RESTORED_SERVER_ID=""

# Asks for the Nightscout of every restored patient: a backup never holds tokens (or holds them encrypted with another
# server's key).
ask_restored_nightscouts() {
  local patients count index id name url
  patients="$(admin_json patients || true)"
  count="$(printf '%s' "$patients" | jq -r '.patients | length' 2>/dev/null || echo 0)"
  [ "$count" -gt 0 ] || return 0
  title "Nightscout podopiecznych z kopii"
  hint "Kopia nie zawiera tokenów: wklej je ponownie (tylko do odczytu)."
  for ((index = 0; index < count; index++)); do
    id="$(printf '%s' "$patients" | jq -r ".patients[$index].patient_id")"
    name="$(printf '%s' "$patients" | jq -r ".patients[$index].display_name")"
    url="$(printf '%s' "$patients" | jq -r ".patients[$index].nightscout_url // empty")"
    say "Podopieczny: ${C_BOLD}$name${C_OFF}"
    set_patient_nightscout "$id" "$name" "$url" || true
  done
}

# The scp command for the Mac ("Pobierz najnowszą", Odinstaluj). PORT and ADRES-SERWERA stay placeholders: the port
# this server sees (SSH_CONNECTION) is not the one the Mac connects to behind NAT (Mikrus: e.g. 10123 outside, 22 here).
download_command() {
  printf 'mkdir -p ~/Mellis-kopie && scp -P PORT root@ADRES-SERWERA:%s ~/Mellis-kopie/\n' "$1"
}

# The one wording for every scp hint (download, uninstall, restore).
SCP_HINT="PORT i ADRES-SERWERA jak w komendzie ssh z notatki „Mellis”."

show_download() {
  local file
  file="$(latest_backup)"
  [ -z "$file" ] && { warn "Nie ma jeszcze żadnej kopii. Zrób ją: mellis backup"; return 0; }
  say "Najnowsza kopia: $(basename "$file") ($(du -h "$file" | cut -f1))"
  say ""
  say "Otwórz ${C_BOLD}nowe okno Terminala${C_OFF} (⌘N): to okno działa na Macu. Wklej tam:"
  say ""
  say "  $(download_command "$file")"
  say ""
  hint "$SCP_HINT"
  hint "Terminal zapyta o hasło do serwera. Kopia trafi do katalogu ~/Mellis-kopie."
}

pick_backup() {
  local __var="$1" __files=() __index=1 __choice __file
  while IFS= read -r __file; do __files+=("$__file"); done < <(backup_files | sort -r)
  [ "${#__files[@]}" -eq 0 ] && { warn "Nie ma kopii w $BACKUP_DIR."; return 1; }
  say "Kopie (najnowsza pierwsza):"
  for __file in "${__files[@]}"; do say "  $__index. $(backup_age_text "$__file") · $(basename "$__file")"; __index=$((__index + 1)); [ "$__index" -gt 30 ] && break; done
  while :; do
    ask __choice "Którą przywrócić (numer)" 1
    if [[ "$__choice" =~ ^[0-9]+$ ]] && [ "$__choice" -ge 1 ] && [ "$__choice" -le "${#__files[@]}" ]; then break; fi
  done
  printf -v "$__var" '%s' "${__files[$((__choice - 1))]}"
}

cmd_backup() {
  local file
  if [ "${1:-}" = "--cron" ]; then
    file="$(make_backup)" && printf '%s backup ok: %s (%s)\n' "$(date -u +%FT%TZ)" "$file" "$(du -h "$file" | cut -f1)"
    return
  fi
  file="$(make_backup)" || return 1
  ok "Kopia zapisana: $(basename "$file") ($(du -h "$file" | cut -f1))."
}

cmd_restore() {
  local file="${1:-}" safety
  if [ -z "$file" ]; then pick_backup file || return 0; fi
  say "Przywrócę: $(basename "$file")"
  warn "Dane zapisane po tej kopii przepadną. W tym czasie nie przyjdą powiadomienia."
  ask_yes "Przywrócić?" n || return 0
  safety="$(make_backup przed-przywroceniem)" && hint "Na wszelki wypadek obecny stan zapisany w: $(basename "$safety")"
  restore_backup "$file" || return 1
  if [ -n "$RESTORED_SERVER_ID" ] && [ "$RESTORED_SERVER_ID" != "$(env_get MELLIS_SERVER_ID)" ]; then
    ask_restored_nightscouts
  fi
  dc up -d >/dev/null
  apply_ai_limit || true
  wait_for_server "$(current_version)" && ok "Mellis działa."
}

menu_backup() {
  local choice
  say "Ostatnia kopia: $(backup_age_text "$(latest_backup)") · kopie co noc o 03:00, trzymane $BACKUP_KEEP_DAYS dni"
  choose choice "Kopia zapasowa:" 1 "Zrób kopię teraz" "Pobierz najnowszą na Maca" "Przywróć" "Wróć"
  case "$choice" in
    1) cmd_backup ;;
    2) show_download ;;
    3) cmd_restore ;;
  esac
}

# --------------------------------------------------------------------------------------------------------------------
# Update, versions, rollback
# --------------------------------------------------------------------------------------------------------------------

# Only X.Y.Z goes on (an image tag, a kit URL, the .env): anything else from GitHub's answer is dropped.
release_versions_only() {
  grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true
}

latest_release() {
  curl -fsS -m 10 "https://api.github.com/repos/$MELLIS_REPO/releases/latest" 2>/dev/null | jq -r '.tag_name // empty' 2>/dev/null | sed 's/^v//' | release_versions_only | head -n 1 || true
}

release_list() {
  curl -fsS -m 10 "https://api.github.com/repos/$MELLIS_REPO/releases?per_page=20" 2>/dev/null \
    | jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name' 2>/dev/null | sed 's/^v//' | release_versions_only || true
}

cmd_check_update() {
  local latest
  latest="$(latest_release)"
  [ -z "$latest" ] && return 0
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$latest" > "$STATE_DIR/latest-version"
  if [ "${1:-}" != "--cron" ]; then
    if version_gt "$latest" "$(current_version)"; then say "Dostępna nowa wersja: $latest (masz $(current_version)). Zaktualizuj: mellis update"; else ok "Masz najnowszą wersję ($(current_version))."; fi
  fi
}

available_update() {
  local latest
  latest="$(cat "$STATE_DIR/latest-version" 2>/dev/null || true)"
  [ -n "$latest" ] && version_gt "$latest" "$(current_version)" && printf '%s' "$latest"
  return 0
}

# switch_version TARGET [backup to restore]: new kit + image, start, check; the caller decides about a rollback.
switch_version() {
  local target="$1" restore_file="${2:-}"
  install_kit "$target"
  env_set MELLIS_VERSION "$target"
  dc pull -q >/dev/null 2>&1 || true
  if [ -n "$restore_file" ]; then restore_backup "$restore_file" || return 1; fi
  dc up -d --remove-orphans >/dev/null 2>&1 || return 1
  wait_for_server "$target"
}

# mellis update [X.Y.Z]: backup → new version → migrate → check; on failure the previous version and the database
# from that backup come back by themselves.
cmd_update() {
  local target="${1:-}" previous backup
  previous="$(current_version)"
  if [ -z "$target" ]; then
    target="$(latest_release)"
    [ -z "$target" ] && { err "Nie udało się sprawdzić najnowszej wersji (GitHub). Podaj ją: mellis update 1.2.0"; return 1; }
  fi
  target="${target#v}"
  if ! [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then err "Wersja to trzy liczby, np. 1.2.0 (podano: $target)."; return 1; fi
  if [ "$target" = "$previous" ]; then ok "Masz najnowszą wersję ($previous)."; return 0; fi
  if version_gt "$previous" "$target"; then err "Wersja $target jest starsza niż obecna ($previous). Powrót: mellis → Zmień ustawienia → Wersja."; return 1; fi
  title "Aktualizacja Mellisa: $previous → $target"
  say "1. Kopia bazy danych…"
  backup="$(make_backup "przed-$target")" || { err "Bez kopii nie aktualizuję."; return 1; }
  ok "Kopia: $(basename "$backup")"
  state_set LAST_UPDATE_FROM "$previous"
  state_set LAST_UPDATE_BACKUP "$backup"
  say "2. Pobieram nową wersję, 3. aktualizuję bazę i uruchamiam, 4. sprawdzam…"
  if switch_version "$target"; then
    ok "Mellis $target działa."
    printf '%s\n' "$target" > "$STATE_DIR/latest-version" 2>/dev/null || true
    # A new release may ship a changed knowledge base: rebuilt only when it changed.
    build_knowledge
    if [ "$KNOWLEDGE_ENV_CHANGED" = 1 ]; then dc up -d --remove-orphans >/dev/null 2>&1 || true; fi
    hint "Teraz zaktualizuj aplikację na Macu (instrukcja: Aktualizacje → Aplikacja)."
    return 0
  fi
  err "Nowa wersja nie ruszyła. Wracam do $previous i przywracam bazę sprzed aktualizacji…"
  if switch_version "$previous" "$backup"; then
    ok "Mellis $previous działa jak przed aktualizacją. Zgłoś problem: mellis → Status i logi → Raport do zgłoszenia."
  else
    err "Powrót się nie udał. Zobacz: mellis → Status i logi, kopia jest w $backup"
  fi
  return 1
}

# Zmień ustawienia → Wersja: newer = update; older = back to it with the database from the backup taken while it ran.
cmd_set_version() {
  local versions=() choice target backup current index=1 version
  current="$(current_version)"
  while IFS= read -r version; do [ -n "$version" ] && versions+=("$version"); done < <(release_list)
  if [ "${#versions[@]}" -eq 0 ]; then ask target "Numer wersji (np. 1.1.0)"; else
    say "Wersje (obecna: $current):"
    for version in "${versions[@]}"; do say "  $index. $version"; index=$((index + 1)); done
    while :; do
      ask choice "Numer z listy" 1
      if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#versions[@]}" ]; then break; fi
    done
    target="${versions[$((choice - 1))]}"
  fi
  [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { err "To nie jest numer wersji."; return 1; }
  [ "$target" = "$current" ] && { ok "Ta wersja już działa."; return 0; }
  if version_gt "$target" "$current"; then cmd_update "$target"; return; fi
  backup="$(for file in $(backup_files | sort -r); do [ "$(backup_manifest "$file" | sed -n 's/^version=//p')" = "$target" ] && { printf '%s' "$file"; break; }; done)"
  if [ -z "$backup" ]; then
    err "Nie ma kopii zrobionej na wersji $target, więc powrót niszczyłby bazę (zmiany bazy działają tylko do przodu)."
    return 1
  fi
  warn "Powrót do $target przywraca bazę z kopii $(basename "$backup"): dane zapisane od tamtej pory przepadną."
  ask_yes "Wrócić do $target?" n || return 0
  make_backup "przed-powrotem-$target" >/dev/null || true
  if switch_version "$target" "$backup"; then ok "Mellis $target działa. Zbuduj aplikację w tej samej wersji: install-app.sh -- --ref v$target"; else err "Powrót się nie udał. Zobacz: mellis → Status i logi."; fi
}

# --------------------------------------------------------------------------------------------------------------------
# Status, logs, report
# --------------------------------------------------------------------------------------------------------------------

server_state_text() {
  if worker_running && local_app_config | jq -e '.server' >/dev/null 2>&1; then printf 'działa'; else printf '%snie działa%s' "$C_ERR" "$C_OFF"; fi
}

cmd_status() {
  local status patients
  title "Mellis $(current_version) · $(server_state_text)"
  say "Adres: $(env_get PUBLIC_BASE_URL)"
  say "Ostatnia kopia: $(backup_age_text "$(latest_backup)")"
  [ -n "$(available_update)" ] && say "Dostępna aktualizacja: $(available_update) (mellis update)"
  dc ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || dc ps
  patients="$(admin_json patients || true)"
  printf '%s' "$patients" | tjq -r '.patients[]? | "Nightscout · \(.display_name): " + (if .last_reading_at then "ostatni odczyt \(.last_reading_at | local_when)" else "jeszcze nic nie pobrano" end) + (if .has_token then "" else " (brak tokenu: mellis → Zmień ustawienia → Nightscout)" end)' 2>/dev/null || true
  status="$(admin_json ai-status || true)"
  if printf '%s' "$status" | jq -e '.total_budget' >/dev/null 2>&1; then
    printf '%s' "$status" | tjq -r '"AI (" + (env.AI_PROVIDER // "") + "): wydano \(.charged) z \(.total_budget) \(.currency) w tym miesiącu, \(.calls) wywołań" + (if .limit_reached then " · LIMIT WYCZERPANY do \(.resets_at | epoch | strflocaltime("%d.%m.%Y %H:%M"))" else "" end)' 2>/dev/null \
      | sed "s/AI ()/AI ($(env_get AI_PROVIDER))/"
  else
    say "AI: $(env_get AI_PROVIDER)"
  fi
  say "Pamięć: $(free -m 2>/dev/null | awk '/^Mem:/ {print $3 " z " $2 " MB zajęte"}')  · dysk: $(df -h "$MELLIS_ROOT" | awk 'NR == 2 {print $4 " wolne"}')"
}

access_kind() {
  case "$(env_get COMPOSE_PROFILES)" in
    caddy) printf 'własna domena (Caddy)' ;;
    tunnel) printf 'Cloudflare Tunnel' ;;
    *) printf 'port API (np. Mikrus)' ;;
  esac
}

cmd_logs() { dc logs --no-color --tail "${1:-150}" api worker; }

# No keys, no medical data, no names, no server address: versions, states, counts, and which log events occurred.
cmd_report() {
  local file logs
  file="/root/mellis-raport-$(date +%Y%m%d-%H%M).txt"
  [ -w /root ] || file="$MELLIS_ROOT/mellis-raport-$(date +%Y%m%d-%H%M).txt"
  logs="$(dc logs --no-color --since 24h api worker 2>/dev/null || true)"
  {
    say "Mellis — raport do zgłoszenia ($(date -u +%FT%TZ))"
    say "Bez kluczy, bez danych medycznych, bez imion i bez adresu serwera."
    say ""
    say "Wersja: $(current_version)  ·  dostępna: $(cat "$STATE_DIR/latest-version" 2>/dev/null || echo '?')"
    # shellcheck disable=SC1090
    say "System: $( (. "$MELLIS_OS_RELEASE" 2>/dev/null && printf '%s' "${PRETTY_NAME:-?}") ) · $(uname -m) · jądro $(uname -r)"
    say "Docker: $(docker --version 2>/dev/null | sed 's/,.*//') · $(docker compose version --short 2>/dev/null)"
    say "Pamięć: $(free -m 2>/dev/null | awk '/^Mem:/ {print $3 "/" $2 " MB"}') · dysk wolny: $(df -h "$MELLIS_ROOT" | awk 'NR == 2 {print $4}')"
    say "Nightscout na tym serwerze: $(nightscout_on_host && echo tak || echo nie)"
    say "Dostęp: $(access_kind)"
    say "AI: $(env_get AI_PROVIDER) · klucz OpenAI: $([ -n "$(env_get OPENAI_API_KEY)" ] && echo tak || echo nie) · głos na serwerze: $(env_get VOICE_TRANSCRIPTION_ENABLED)"
    say "Powiadomienia: $(env_get PUSH_PROVIDER) · sandbox: $(env_get APNS_USE_SANDBOX)"
    say "Ostatnia kopia: $(backup_age_text "$(latest_backup)")"
    say ""
    say "Kontenery:"
    for service in postgres migrate api worker caddy cloudflared; do
      local cid
      cid="$(container_of "$service")"
      [ -n "$cid" ] && say "  $service: $(docker inspect -f '{{.State.Status}} (kod {{.State.ExitCode}}, restartów {{.RestartCount}}, od {{.State.StartedAt}})' "$cid" 2>/dev/null)"
    done
    say ""
    say "Konfiguracja serwera:"
    admin_json setup-status | jq -r '"  tryb: \(.auth_mode), konfiguracja: \(.setup), podopiecznych: \(.patients), właścicieli: \(.owners), telefonów: \(.devices)"' 2>/dev/null || say "  (nie udało się odczytać)"
    admin_json ai-status | jq -r '"  limit AI: \(.period), wydano \(.charged)/\(.total_budget) \(.currency), wywołań \(.calls), wyczerpany: \(.limit_reached)"' 2>/dev/null || true
    admin_json patients | jq -r '.patients | to_entries[] | "  podopieczny \(.key + 1): token \(if .value.has_token then "jest" else "brak" end), ostatni odczyt " + (if .value.last_reading_at then "\(((now - (.value.last_reading_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) / 60 | floor)) min temu" else "brak" end)' 2>/dev/null || true
    say ""
    say "Zdarzenia z logów (24 h, tylko nazwy):"
    printf '%s\n' "$logs" | grep -o '"event":"[A-Za-z0-9_.:-]*"' | sed 's/"event":"\(.*\)"/\1/' | sort | uniq -c | sort -rn | head -40 | sed 's/^/  /' || true
    say ""
    say "Kody błędów z logów (24 h):"
    printf '%s\n' "$logs" | grep -Eo '"(code|reason|error_code)":"[A-Z][A-Z0-9_]+"' | sed 's/.*:"\(.*\)"/\1/' | sort | uniq -c | sort -rn | head -30 | sed 's/^/  /' || true
    printf '  linie z błędem: %s\n' "$(printf '%s\n' "$logs" | grep -Eci '"level":"?(error|50)|\berror\b' || true)"
  } > "$file"
  chmod 600 "$file"
  cat "$file"
  say ""
  ok "Raport zapisany: $file"
  hint "Przejrzyj go przed wysłaniem. Wklej go do zgłoszenia na GitHubie."
}

menu_status() {
  local choice
  cmd_status
  choose choice "Status i logi:" 3 "Pokaż logi (ostatnie 150 linii)" "Raport do zgłoszenia" "Wróć"
  case "$choice" in
    1) cmd_logs ;;
    2) cmd_report ;;
  esac
}

# --------------------------------------------------------------------------------------------------------------------
# Phones of the owner
# --------------------------------------------------------------------------------------------------------------------

show_qr() {
  local url="$1"
  if command -v qrencode >/dev/null 2>&1; then qrencode -t ANSIUTF8 -m 2 "$url"; else warn "Brak programu qrencode: użyj linku poniżej."; fi
}

# pick_owner VAR: with more than one owner (a restored database can hold a leftover test person, created first), asks
# "Kogo połączyć?" with what tells them apart; VAR = the chosen user id. One owner (or none): VAR = "", no question,
# and reset-owner takes the server's default (the recovery person, else the longest-standing owner).
pick_owner() {
  local __var="$1" __owners __count __default __pick __line __labels=()
  printf -v "$__var" '%s' ""
  __owners="$(admin_json owners || true)"
  __count="$(printf '%s' "$__owners" | jq -r '.owners | length' 2>/dev/null || echo 0)"
  [ "${__count:-0}" -gt 1 ] 2>/dev/null || return 0
  # The default: the most recently active owner (the first one when nobody was ever active).
  __default="$(printf '%s' "$__owners" | jq -r '[.owners[] | .last_active_at // ""] as $a | ($a | max) as $m | if $m == "" then 1 else ([range($a | length) | select($a[.] == $m)] | first) + 1 end' 2>/dev/null || echo 1)"
  while IFS= read -r __line; do __labels+=("$__line"); done < <(printf '%s' "$__owners" | tjq -r '
    def phones: if . == 0 then "bez telefonu" elif . == 1 then "1 telefon"
      elif (. % 10 >= 2 and . % 10 <= 4 and (. % 100 < 10 or . % 100 >= 20)) then "\(.) telefony" else "\(.) telefonów" end;
    .owners[] | .display_name
      + " · " + (if .last_active_at then "ostatnio aktywny \(.last_active_at | local_when)" elif .has_login_history then "brak śladu aktywności" else "nigdy nie używany (bez logowania i wiadomości)" end)
      + " · " + (.devices | phones)
      + (if .recovery_person then " · ma kod odzyskiwania" else "" end)')
  [ "${#__labels[@]}" -eq "$__count" ] || return 0
  say "Na serwerze jest $__count właścicieli (np. z przywróconej kopii)."
  choose __pick "Kogo połączyć?" "$__default" "${__labels[@]}"
  printf -v "$__var" '%s' "$(printf '%s' "$__owners" | jq -r ".owners[$((__pick - 1))].user_id")"
}

# mellis → Połącz telefon właściciela: a 10-minute code for the owner chosen (pick_owner), else the server's default.
# PAIRED_OWNER_ID: who it was for (Odzyskaj dostęp makes the recovery code for the same person).
PAIRED_OWNER_ID=""
cmd_pair_owner() {
  local answer url code expires user=""
  ensure_tools >/dev/null 2>&1 || true
  pick_owner user
  if [ -n "$user" ]; then answer="$(admin_json reset-owner --user "$user" || true)"; else answer="$(admin_json reset-owner || true)"; fi
  url="$(printf '%s' "$answer" | jq -r '.pairing_url // empty' 2>/dev/null || true)"
  if [ -z "$url" ]; then
    case "$(printf '%s' "$answer" | jq -r '.error // empty' 2>/dev/null)" in
      NO_OWNER_TO_RESET|SETUP_NEEDS_PATIENT) err "Serwer nie ma jeszcze właściciela: dokończ instalację (uruchom instalator ponownie)." ;;
      NOT_AN_OWNER) err "Ta osoba nie jest już właścicielem. Uruchom: mellis → Połącz telefon właściciela ponownie." ;;
      PUBLIC_BASE_URL_MISSING) err "Serwer nie zna swojego adresu, więc nie zrobi linku dla telefonu. Ustaw go: mellis → Zmień ustawienia → Domena / adres serwera." ;;
      *) err "Nie udało się zrobić kodu: $(printf '%s' "$answer" | jq -r '.error // empty' 2>/dev/null)" ;;
    esac
    return 1
  fi
  code="$(printf '%s' "$answer" | jq -r '.code')"
  expires="$(printf '%s' "$answer" | jq -r '.expires_at')"
  PAIRED_OWNER_ID="$(printf '%s' "$answer" | jq -r '.user_id // empty')"
  title "Połącz telefon: $(printf '%s' "$answer" | jq -r '.display_name')"
  say "W aplikacji na ekranie łączenia stuknij ${C_BOLD}Zeskanuj kod${C_OFF} i zeskanuj:"
  show_qr "$url"
  say "Albo wklej w aplikacji link:"
  say "  $url"
  say "Kod: $code · działa 10 minut (do $(local_clock_text "$expires"))."
}

cmd_recover_owner() {
  title "Odzyskaj dostęp właściciela"
  say "Dostęp do serwera wystarczy jako dowód: nowy telefon połączy się jako właściciel."
  cmd_pair_owner || return 1
  if ask_yes "Zrobić też nowy kod odzyskiwania? Stary przestanie działać." t; then
    local answer
    if [ -n "$PAIRED_OWNER_ID" ]; then answer="$(admin_json recovery-code --user "$PAIRED_OWNER_ID" || true)"; else answer="$(admin_json recovery-code || true)"; fi
    if printf '%s' "$answer" | jq -e '.recovery_code' >/dev/null 2>&1; then
      say "Nowy kod odzyskiwania (zapisz w notatce „Mellis”, pokazywany tylko raz):"
      say "  ${C_BOLD}$(printf '%s' "$answer" | jq -r '.recovery_code')${C_OFF}"
    else
      err "Nie udało się zrobić kodu odzyskiwania."
    fi
  fi
  hint "Potem odłącz zgubiony telefon: Mellis → Ustawienia → Udostępnianie → osoba → urządzenie → Odłącz."
}

# --------------------------------------------------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------------------------------------------------

# The knowledge base shipped in the image (guidelines as summaries with links, Trio/OpenAPS docs): indexed on this
# server by `mellis-admin knowledge-build` (full text; with an OpenAI key also embeddings under the AI limit). Rebuilds
# only when the corpus or the mode changed, so every update can call it. Never fatal: without it the AI answers
# without sources. Sets KNOWLEDGE_ENV_CHANGED=1 when it switched the search on (the worker must restart to see it).
KNOWLEDGE_ENV_CHANGED=0
build_knowledge() {
  local result status mode
  KNOWLEDGE_ENV_CHANGED=0
  say "Baza wiedzy (wytyczne i dokumentacja pętli)…"
  result="$(admin_json knowledge-build || true)"
  status="$(printf '%s' "$result" | jq -r 'if .ok == true then .status else empty end' 2>/dev/null || true)"
  mode="$(printf '%s' "$result" | jq -r '.mode // empty' 2>/dev/null || true)"
  case "$status" in
    BUILT|UNCHANGED)
      if [ "$(env_get AI_ENABLE_KNOWLEDGE_SEARCH)" != 1 ]; then env_set AI_ENABLE_KNOWLEDGE_SEARCH 1; KNOWLEDGE_ENV_CHANGED=1; fi
      if [ "$mode" = "hybrid" ]; then
        ok "Baza wiedzy gotowa."
      else
        ok "Baza wiedzy gotowa (wyszukiwanie po słowach)."
        if [ -n "$(env_get OPENAI_API_KEY)" ]; then hint "Wektory OpenAI nie powstały teraz: spróbuję przy następnej aktualizacji."; fi
      fi ;;
    FOREIGN_CORPUS_KEPT)
      # A corpus loaded earlier (e.g. restored with a backup of an older installation) stays and is searched: it is
      # complete, only not built by this command (dress rehearsal: the restored corpus was left switched off).
      if [ "$(env_get AI_ENABLE_KNOWLEDGE_SEARCH)" != 1 ]; then env_set AI_ENABLE_KNOWLEDGE_SEARCH 1; KNOWLEDGE_ENV_CHANGED=1; fi
      ok "Baza wiedzy: zostawiam wczytaną wcześniej ($(printf '%s' "$result" | jq -r '.kept_version // "?"' 2>/dev/null))." ;;
    *)
      warn "Bazy wiedzy nie udało się przygotować: AI odpowiada bez źródeł. Spróbuję ponownie przy aktualizacji (mellis update)." ;;
  esac
  return 0
}

restart_app() {
  say "Uruchamiam Mellisa ponownie…"
  dc up -d --remove-orphans >/dev/null
  wait_for_server "$(current_version)" && ok "Mellis działa."
}

menu_settings() {
  local choice patients count index id name url pick
  choose choice "Zmień ustawienia:" 7 "Nightscout" "Klucz AI" "Limit AI" "Domena / adres serwera" "APNs (powiadomienia)" "Wersja" "Wróć"
  case "$choice" in
    1)
      patients="$(admin_json patients || true)"
      count="$(printf '%s' "$patients" | jq -r '.patients | length' 2>/dev/null || echo 0)"
      [ "$count" -gt 0 ] || { err "Na serwerze nie ma podopiecznych."; return 1; }
      pick=1
      if [ "$count" -gt 1 ]; then
        local names=()
        for ((index = 0; index < count; index++)); do names+=("$(printf '%s' "$patients" | jq -r ".patients[$index].display_name")"); done
        choose pick "Którego podopiecznego?" 1 "${names[@]}"
      fi
      id="$(printf '%s' "$patients" | jq -r ".patients[$((pick - 1))].patient_id")"
      name="$(printf '%s' "$patients" | jq -r ".patients[$((pick - 1))].display_name")"
      url="$(printf '%s' "$patients" | jq -r ".patients[$((pick - 1))].nightscout_url // empty")"
      set_patient_nightscout "$id" "$name" "$url" && hint "Mellis użyje nowego Nightscouta przy następnym pobraniu danych (do minuty)."
      ;;
    2) ask_ai; apply_ai_limit || true; build_knowledge; restart_app ;;
    3) ask_ai_limit; apply_ai_limit ;;
    4) ask_address; restart_app; public_url_works "$(env_get PUBLIC_BASE_URL)" && ok "Adres działa: $(env_get PUBLIC_BASE_URL)"; warn "Telefony połączone ze starym adresem trzeba połączyć ponownie: mellis → Połącz telefon właściciela, potem zaproszenia dla pozostałych." ;;
    5) ask_apns; restart_app ;;
    6) cmd_set_version ;;
  esac
}

# --------------------------------------------------------------------------------------------------------------------
# Uninstall
# --------------------------------------------------------------------------------------------------------------------

remove_installation() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$(image_name):$(current_version)" >/dev/null 2>&1 || true
  rm -f "$MELLIS_CRON_FILE"
  if [ "$(readlink "$MELLIS_BIN_DIR/mellis" 2>/dev/null || true)" = "$MELLIS_ROOT/mellis" ] || [ -f "$MELLIS_BIN_DIR/mellis" ]; then rm -f "$MELLIS_BIN_DIR/mellis"; fi
  rm -rf "$MELLIS_ROOT"
}

cmd_uninstall() {
  local choice file confirm
  title "Odinstaluj Mellisa"
  say "Mellis nie ruszy niczego poza swoim katalogiem: Nightscout i inne usługi na tym serwerze działają dalej."
  choose choice "Co zrobić z danymi?" 3 "Zachowaj dane (kopia bazy i ustawień w $MELLIS_KEEP_DIR)" "Usuń wszystko" "Wróć"
  case "$choice" in
    1)
      file="$(make_backup odinstalowanie)" || { err "Kopia się nie udała: nic nie usuwam."; return 1; }
      mkdir -p "$MELLIS_KEEP_DIR"; chmod 700 "$MELLIS_KEEP_DIR"
      cp "$file" "$MELLIS_KEEP_DIR/"
      settings_without_keys "$ENV_FILE" > "$MELLIS_KEEP_DIR/settings.env"
      chmod 600 "$MELLIS_KEEP_DIR"/*
      ask_yes "Usunąć Mellisa z tego serwera (dane zostaną w $MELLIS_KEEP_DIR)?" n || return 0
      remove_installation
      ok "Mellis usunięty. Kopia: $MELLIS_KEEP_DIR/$(basename "$file")"
      hint "Wrócisz instalatorem, wybierając „Przywróć z kopii”."
      ;;
    2)
      if file="$(make_backup odinstalowanie)"; then
        say "Zanim usuniesz wszystko, pobierz ostatnią kopię na Maca:"
        say "  $(download_command "$file")"
        hint "$SCP_HINT"
        ask confirm "Naciśnij Enter, gdy kopia jest na Macu (albo gdy jej nie chcesz)"
      fi
      warn "Usunę Mellisa, bazę danych, zdjęcia, ustawienia, klucze i nocne kopie. Tego nie da się cofnąć."
      ask confirm "Wpisz USUŃ, żeby potwierdzić"
      [ "$confirm" = "USUŃ" ] || [ "$confirm" = "USUN" ] || { say "Nic nie usunięto."; return 0; }
      remove_installation
      ok "Mellis usunięty w całości."
      ;;
  esac
}

# --------------------------------------------------------------------------------------------------------------------
# The installer
# --------------------------------------------------------------------------------------------------------------------

# GET /v1/setup, retried: right after `up` compose may still recreate the api once the migrations finish, so the first
# answer can come from an instance that is about to stop (seen in the dress rehearsal: "Empty reply from server").
setup_status_json() {
  local waited=0
  while :; do
    api_call GET /v1/setup
    [ "$API_STATUS" = "200" ] && break
    waited=$((waited + (MELLIS_SLEEP > 0 ? MELLIS_SLEEP : 1)))
    [ "$waited" -gt "$MELLIS_WAIT_SECONDS" ] && break
    pause
  done
  printf '%s' "$API_BODY"
}

start_base_stack() {
  say "Uruchamiam serwer Mellisa. Za pierwszym razem to może potrwać kilka minut…"
  dc up -d postgres >/dev/null
  wait_for_postgres || die "Baza danych nie wystartowała. Zobacz: docker compose logs postgres (w $MELLIS_ROOT)."
  dc up -d migrate api >/dev/null 2>&1 || true
  local waited=0
  until local_app_config | jq -e '.server' >/dev/null 2>&1; do
    waited=$((waited + (MELLIS_SLEEP > 0 ? MELLIS_SLEEP : 1)))
    [ "$waited" -gt "$MELLIS_WAIT_SECONDS" ] && die "Mellis nie wystartował. Zobacz: mellis logs"
    pause
  done
  ok "Serwer działa."
}

# "Przywróć z kopii" at the start: a file copied from the Mac (or kept by Odinstaluj → Zachowaj dane).
ask_restore_file() {
  local __var="$1" __default __file
  __default="$( { ls -t "$MELLIS_KEEP_DIR"/mellis-*.tar.gz /root/mellis-*.tar.gz /root/*.dump "${HOME:-/root}"/mellis-*.tar.gz 2>/dev/null || true; } | head -n 1)"
  say "Skopiuj plik kopii na serwer: w ${C_BOLD}nowym oknie Terminala${C_OFF} na Macu wpisz"
  say "  scp -P PORT ~/Mellis-kopie/NAZWA-PLIKU root@ADRES-SERWERA:/root/"
  hint "$SCP_HINT"
  hint "Plik z Mellisa to mellis-….tar.gz, kopia starej instalacji to plik .dump."
  while :; do
    ask __file "Ścieżka do pliku na serwerze" "$__default"
    [ -f "$__file" ] && break
    err "Nie ma takiego pliku: $__file"
  done
  printf -v "$__var" '%s' "$__file"
}

summary() {
  local url="$1" setup_code="$2" recovery="$3" owners="${4:-0}"
  say ""
  ok "Mellis działa: $url"
  ok "Pierwsza kopia bazy zapisana."
  say ""
  say "Zapisz w notatce „Mellis”:"
  printf '  Adres serwera:      %s\n' "$url"
  if [ -n "$setup_code" ]; then
    printf '  Kod konfiguracji:   %s   (do instalacji aplikacji)\n' "$setup_code"
    say ""
    say "Aplikację zainstalujesz na Macu (nowe okno Terminala) komendą:"
    # shellcheck disable=SC2016 # the command is printed for the Mac, not run here
    printf '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/%s/v%s/scripts/install-app.sh)" -- --server %s --code %s\n' "$MELLIS_REPO" "$(current_version)" "$url" "$setup_code"
    hint "Kod odzyskiwania pokaże skrypt na Macu, gdy połączy Twój telefon: zapisz go wtedy w notatce."
  else
    printf '  Kod konfiguracji:   —   (telefon połączysz: mellis → Połącz telefon właściciela)\n'
    if [ "$owners" -gt 1 ] 2>/dev/null; then
      hint "Kopia ma $owners właścicieli: przy łączeniu telefonu Mellis zapyta „Kogo połączyć?” i wybierzesz siebie z listy."
    fi
    if [ "$recovery" = "new" ]; then
      hint "Ta kopia nie ma kodu odzyskiwania: po połączeniu telefonu zrób go w mellis → Odzyskaj dostęp właściciela."
    else
      hint "Kod odzyskiwania z notatki działa dalej."
    fi
  fi
  say ""
  say "Zarządzanie serwerem: wpisz  mellis"
}

cmd_install() {
  local version="${1:-$MELLIS_DEFAULT_VERSION}" mode status setup open patients first_owner recovery="" file url setup_code="" restored_status owners=0
  title "Mellis · instalacja serwera"
  if [ -f "$STATE_DIR/install.done" ]; then
    ok "Mellis jest już zainstalowany na tym serwerze."
    say "Zarządzanie: wpisz  mellis"
    return 0
  fi
  accept_diy
  preflight
  ensure_tools
  install_docker
  prepare_dirs
  [ -n "$(current_version)" ] && version="$(current_version)"
  write_base_env "$version"
  install_kit "$version"
  ok "Mellis $version w $MELLIS_ROOT"

  # 1. New install or a backup?
  mode="$(state_get MODE)"
  if [ -z "$mode" ]; then
    local pick
    choose pick "Zacznij od:" 1 "Nowa instalacja" "Przywróć z kopii (przeprowadzka na nowy serwer, kopia starej instalacji)"
    if [ "$pick" = 2 ]; then mode=restore; else mode=new; fi
    state_set MODE "$mode"
  fi

  if [ "$mode" = "restore" ] && [ "$(state_get RESTORED)" != 1 ]; then
    ask_restore_file file
    # A backup from a newer release is restored into that release (migrations only go forward).
    local backup_version
    backup_version="$(backup_manifest "$file" | sed -n 's/^version=//p')"
    if [ -n "$backup_version" ] && version_gt "$backup_version" "$(current_version)"; then
      say "Kopia pochodzi z wersji $backup_version: instaluję tę wersję."
      install_kit "$backup_version"
      env_set MELLIS_VERSION "$backup_version"
    fi
    dc up -d postgres >/dev/null
    restore_backup "$file" || die "Przywracanie się nie udało. Uruchom instalator ponownie."
    state_set RESTORED 1
    if [ -f "$STATE_DIR/restored-settings.env" ]; then
      for key in AI_MONTHLY_LIMIT_USD APNS_KEY_ID APNS_TEAM_ID TZ; do
        [ -n "$(env_get "$key" "$STATE_DIR/restored-settings.env")" ] && env_set "$key" "$(env_get "$key" "$STATE_DIR/restored-settings.env")"
      done
    fi
  fi

  start_base_stack
  status="$(setup_status_json)"
  setup="$(printf '%s' "$status" | jq -r '.setup // empty')"
  [ -n "$setup" ] || die "Serwer nie odpowiada poprawnie (GET /v1/setup). Zobacz: mellis logs"
  open=0; [ "$setup" = "OPEN" ] && open=1
  SETUP_OPEN="$open"

  if [ "$open" = 1 ]; then
    # 2. Nightscout and the patient(s).
    patients="$(printf '%s' "$status" | jq -r '.patients | length' 2>/dev/null || echo 0)"
    title "Osoba z cukrzycą"
    hint "Ty albo ktoś, kim się opiekujesz: imię i Nightscout tej osoby."
    if [ "$patients" -gt 0 ]; then
      ok "Podopieczni już dodani: $(printf '%s' "$status" | jq -r '[.patients[].display_name] | join(", ")')"
    else
      add_setup_patient
    fi
    while ask_yes "Dodać kolejną osobę, z jej własnym Nightscoutem? (można też później w aplikacji)" n; do add_setup_patient; done

    # The first owner is named by install-app.sh on the Mac with this code (POST /v1/setup/owner), which also shows the
    # recovery code there: each call of that route replaces the recovery code, so the server installer never makes it.
    setup_code="$(env_get SETUP_CODE)"
  else
    if [ "$mode" = "restore" ]; then
      ok "Kopia przywrócona: podopieczni, opiekunowie, posiłki i rozmowy są na miejscu."
      [ "$(state_get NIGHTSCOUTS_DONE)" = 1 ] || { ask_restored_nightscouts; state_set NIGHTSCOUTS_DONE 1; }
      restored_status="$(admin_json setup-status || true)"
      first_owner="$(printf '%s' "$restored_status" | jq -r '.has_recovery_code' 2>/dev/null || echo false)"
      [ "$first_owner" = "true" ] || recovery=new
      owners="$(printf '%s' "$restored_status" | jq -r '.owners // 0' 2>/dev/null || echo 0)"
    else
      ok "Konfiguracja serwera jest już zakończona (pierwszy telefon połączony)."
    fi
  fi

  # 3. AI, 4. APNs, 5. address.
  if [ "$(state_get AI_DONE)" != 1 ]; then title "AI"; ask_ai; state_set AI_DONE 1; fi
  if [ "$(state_get APNS_DONE)" != 1 ]; then title "Powiadomienia (APNs)"; ask_apns; state_set APNS_DONE 1; fi
  if [ "$(state_get ADDRESS_DONE)" != 1 ]; then title "Adres serwera"; ask_address; state_set ADDRESS_DONE 1; fi

  title "Uruchamiam"
  # The ledger first: the worker refuses to start a paid provider without it.
  apply_ai_limit || die "Bez limitu AI serwer nie uruchomi płatnego AI. Uruchom instalator ponownie."
  # After the ledger (embeddings with an OpenAI key are reserved in it), before the worker starts with the search flag.
  build_knowledge
  dc up -d --remove-orphans >/dev/null
  wait_for_server "$(current_version)" || die "Mellis nie wystartował. Zobacz: mellis logs (albo uruchom instalator ponownie)."
  url="$(env_get PUBLIC_BASE_URL)"
  if [ -n "$url" ]; then
    say "Sprawdzam adres $url…"
    if wait_for_public_url "$url"; then ok "Adres działa."; else warn "Adres $url jeszcze nie odpowiada (domena albo certyfikat potrzebują chwili). Sprawdź później: mellis → Status i logi."; fi
  fi
  file="$(make_backup)" || die "Pierwsza kopia się nie udała."
  install_command
  : > "$STATE_DIR/install.done"
  cmd_check_update --cron || true
  summary "$url" "$setup_code" "$recovery" "$owners"
}

# --------------------------------------------------------------------------------------------------------------------
# Menu and entry point
# --------------------------------------------------------------------------------------------------------------------

menu() {
  local choice update
  while :; do
    update="$(available_update)"
    printf '\n%sMellis%s · %s · ostatnia kopia: %s\n' "$C_BOLD" "$C_OFF" "$(server_state_text)" "$(backup_age_text "$(latest_backup)")"
    [ -n "$update" ] && say "${C_WARN}Dostępna aktualizacja: $update${C_OFF} (2. Aktualizuj)"
    choose choice "" 8 \
      "Status i logi" \
      "Aktualizuj" \
      "Kopia zapasowa / przywróć" \
      "Zmień ustawienia (Nightscout, klucz AI, limit AI, domena, APNs, wersja)" \
      "Połącz telefon właściciela (kod QR, gdy pierwszy telefon nie połączył się sam)" \
      "Odzyskaj dostęp właściciela" \
      "Odinstaluj" \
      "Wyjdź"
    case "$choice" in
      1) menu_status ;;
      2) cmd_update || true ;;
      3) menu_backup || true ;;
      4) menu_settings || true ;;
      5) cmd_pair_owner || true ;;
      6) cmd_recover_owner || true ;;
      7) cmd_uninstall; [ -d "$MELLIS_ROOT" ] || return 0 ;;
      8) return 0 ;;
    esac
  done
}

require_root() {
  [ "${MELLIS_ALLOW_NON_ROOT:-0}" = 1 ] && return 0
  [ "$(id -u)" -eq 0 ] && return 0
  command -v sudo >/dev/null 2>&1 || die "Uruchom jako root (albo zainstaluj sudo)."
  say "Mellis potrzebuje uprawnień administratora: sudo zapyta o hasło."
  if [ -n "${BASH_EXECUTION_STRING:-}" ] && [ ! -f "${BASH_SOURCE[0]:-}" ]; then
    exec sudo -E bash -c "$BASH_EXECUTION_STRING" mellis "$@"
  fi
  exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
}

require_installed() {
  [ -f "$ENV_FILE" ] && [ -f "$MELLIS_ROOT/docker-compose.yml" ] || die "Mellis nie jest zainstalowany w $MELLIS_ROOT. Zainstaluj go instalatorem (instrukcja: Serwer)."
}

main() {
  local program command
  program="$(basename "${BASH_SOURCE[0]:-$0}")"
  command="${1:-}"
  if [ -z "$command" ]; then
    if [ "$program" = "mellis" ] && [ -f "$STATE_DIR/install.done" ]; then command=menu; else command=install; fi
  fi
  [ "$#" -gt 0 ] && shift
  case "$command" in
    version|--version) say "Mellis $( [ -f "$ENV_FILE" ] && current_version || printf '%s' "$MELLIS_DEFAULT_VERSION")"; return 0 ;;
    help|--help|-h) sed -n '2,20p' "${BASH_SOURCE[0]}" 2>/dev/null | sed 's/^# \{0,1\}//'; return 0 ;;
  esac
  require_root "$command" "$@"
  case "$command" in
    install) cmd_install "$@" ;;
    menu) require_installed; menu ;;
    status) require_installed; cmd_status ;;
    logs) require_installed; cmd_logs "$@" ;;
    report) require_installed; cmd_report ;;
    update) require_installed; cmd_update "$@" ;;
    backup) require_installed; cmd_backup "$@" ;;
    restore) require_installed; cmd_restore "$@" ;;
    download) require_installed; show_download ;;
    settings) require_installed; menu_settings ;;
    pair-owner) require_installed; cmd_pair_owner ;;
    recover-owner|reset-owner) require_installed; cmd_recover_owner ;;
    uninstall) require_installed; cmd_uninstall ;;
    check-update) require_installed; cmd_check_update "$@" ;;
    setup-code) require_installed; say "Kod konfiguracji: $(env_get SETUP_CODE)" ;;
    knowledge) require_installed; build_knowledge; if [ "$KNOWLEDGE_ENV_CHANGED" = 1 ]; then restart_app; fi ;;
    *) die "Nieznane polecenie: $command (mellis help)" ;;
  esac
}

main "$@"
