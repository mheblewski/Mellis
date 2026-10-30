#!/bin/bash
# The script's globals are set here and read by its functions (sourced below).
# shellcheck disable=SC2034
# shellcheck source-path=SCRIPTDIR
# Tests of scripts/install-app.sh without Xcode, phones or a server: xcrun (devicectl) and curl are stubs on PATH,
# the script is sourced (MELLIS_INSTALL_APP_SOURCED=1) and its functions are called one by one.
#
#   bash scripts/install-app.test.sh
#
# Covers the phone picker text (docs-site/docs/instalacja/aplikacja.md), "Wszystkie z listy" connecting only the first
# phone, the configuration code and link formats, the setup-code exchange and the version choice.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mellis-install-app-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
STUBS="${TMP}/bin"
mkdir -p "$STUBS"
export STUB_LOG="${TMP}/calls.log"
export FAKE_SERVER_DIR="${TMP}/server"
mkdir -p "$FAKE_SERVER_DIR"

FAILED=0
PASSED=0
check() { # check "name" expected actual
  if [ "$2" = "$3" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"
  fi
}
check_contains() { # check_contains "name" needle haystack
  case "$3" in
    *"$2"*) PASSED=$((PASSED + 1)) ;;
    *) FAILED=$((FAILED + 1)); printf 'FAIL %s\n  missing: %s\n  in:\n%s\n' "$1" "$2" "$3" ;;
  esac
}

# --- stubs ---

# Two physical phones (Xcode 27 JSON shape), one simulator that the picker must leave out.
cat >"${TMP}/devices.json" <<'EOF'
{"result": {"devices": [
  {"identifier": "AAAA-1111", "connectionProperties": {"transportType": "localNetwork", "tunnelState": "connected"},
   "deviceProperties": {"name": " iPhone Ani", "osVersionNumber": "26.1", "developerModeStatus": "enabled"},
   "hardwareProperties": {"platform": "iOS", "deviceType": "iPhone", "reality": "physical", "udid": "00008000-AAAA"}},
  {"identifier": "BBBB-2222", "connectionProperties": {"transportType": "wired", "tunnelState": "connected"},
   "deviceProperties": {"name": "iPhone Tomka", "osVersionNumber": "26.0", "developerModeStatus": "enabled"},
   "hardwareProperties": {"platform": "iOS", "deviceType": "iPhone", "reality": "physical", "udid": "00008000-BBBB"}},
  {"identifier": "SIM-3333", "connectionProperties": {"tunnelState": "connected"},
   "deviceProperties": {"name": "iPhone 17 Pro", "osVersionNumber": "26.3"},
   "hardwareProperties": {"platform": "iOS", "deviceType": "iPhone", "reality": "simulated"}}
]}}
EOF

cat >"${STUBS}/xcrun" <<EOF
#!/bin/bash
echo "xcrun \$*" >>"\$STUB_LOG"
if [ "\$1 \$2 \$3" = "devicectl list devices" ]; then
  while [ \$# -gt 0 ]; do
    if [ "\$1" = "--json-output" ]; then cp "${TMP}/devices.json" "\$2"; fi
    shift
  done
  exit 0
fi
if [ "\$1 \$2 \$3 \$4" = "devicectl device process launch" ]; then
  # Opening a pairing link: the fake server's owner phone connects (the app's "Połącz" tapped).
  case "\$*" in *--payload-url*) echo COMPLETED >"\$FAKE_SERVER_DIR/setup_state" ;; esac
fi
exit 0
EOF

# curl: GET /v1/app-config, GET /v1/setup (with or without the setup code), POST /v1/setup/owner.
cat >"${STUBS}/curl" <<'EOF'
#!/bin/bash
out="" method="GET" url="" setup_code=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -X) method="$2"; shift ;;
    -H) case "$2" in X-Mellis-Setup-Code:*) setup_code="${2#X-Mellis-Setup-Code: }" ;; esac; shift ;;
    -w|--max-time|--data-binary) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
echo "curl $method $url ${setup_code:+setup=$setup_code}" >>"$STUB_LOG"
if [ -f "$FAKE_SERVER_DIR/down" ]; then exit 7; fi
state="$(cat "$FAKE_SERVER_DIR/setup_state" 2>/dev/null || echo OPEN)"
version="$(cat "$FAKE_SERVER_DIR/version" 2>/dev/null || echo null)"
status=200
case "$method $url" in
  "GET "*/v1/app-config) body="{\"ios\":{\"min_build\":445},\"server\":{\"version\":${version},\"revision\":null}}" ;;
  "GET "*/v1/setup)
    if [ "$setup_code" = "ZZZZZ-YYYYY-XXXXX-WWWWW" ] && [ "$state" = "OPEN" ]; then
      body="{\"auth_mode\":\"device\",\"setup\":\"$state\",\"setup_code_configured\":true,\"patients\":[],\"first_owner_named\":false}"
    else
      body="{\"auth_mode\":\"device\",\"setup\":\"$state\",\"setup_code_configured\":true}"
    fi ;;
  "POST "*/v1/setup/owner)
    status=201
    body='{"user_id":"u1","first_name":"Ania","pairing":{"code":"4D8PE-QW2Z7-K9M3X-6HTB1","expires_at":"x","pairing_url":"mellis://pair?server=https%3A%2F%2Fmellis.example.pl&code=4D8PE-QW2Z7-K9M3X-6HTB1"},"recovery_code":"RRRRR-RRRRR-RRRRR-RRRRR-RRRRR"}' ;;
  *) status=404; body='{"code":"NOT_FOUND"}' ;;
esac
[ -n "$out" ] && printf '%s' "$body" >"$out"
printf '%s' "$status"
EOF
chmod +x "${STUBS}/xcrun" "${STUBS}/curl"
export PATH="${STUBS}:${PATH}"

export MELLIS_STATE_DIR="${TMP}/state"
export MELLIS_PAIR_POLL_SECONDS=0
export MELLIS_PAIR_WAIT_SECONDS=1
export MELLIS_INSTALL_APP_SOURCED=1
# shellcheck source=install-app.sh
. "${SCRIPT_DIR}/install-app.sh"
set +e

answers() { # answers line... -> the script's questions read these
  printf '%s\n' "$@" >"${TMP}/answers"
  TTY_IN="${TMP}/answers"
  exec 3<"$TTY_IN"
  TTY_FD_OPEN=1
}

reset_run() {
  : >"$STUB_LOG"
  rm -f "$FAKE_SERVER_DIR/setup_state" "$FAKE_SERVER_DIR/down"
  RESULTS="" INSTALLED_IDS="" PAIR_DEVICE_ID="" SELECTED_IDS="" LAST_DEVICES="" LAUNCH_AFTER_INSTALL=""
  PAIRING_CODE="" CODE_KIND="" CODE_FROM_FLAG=0 CODE_FROM_LINK=0 SERVER_STATE="" OPT_CODE="" OPT_SERVER=""
  SERVER_URL="https://mellis.example.pl" BUNDLE_ID="pl.mellis.AB12CD34EF" BUILT_APP="${TMP}/Mellis.app"
  OPT_NO_INSTALL=0 OPT_CONFIGURATION="Release"
}

# --- DIY acknowledgement ---

went_on() { case "$1" in *went-on*) echo "went on" ;; *) echo "stopped" ;; esac; }
unset MELLIS_ACCEPT_DIY
answers "nie"
out="$( (accept_diy; echo "went-on") 2>&1)"
check_contains "consent: the notice shown" "Mellis to projekt DIY, nie wyrób medyczny. Używasz go na własną odpowiedzialność; decyzje o leczeniu podejmujesz Ty." "$out"
check_contains "consent refused: nothing changed" "Nic nie zostało zmienione." "$out"
check "consent refused: stops" "stopped" "$(went_on "$out")"
answers ""
out="$( (accept_diy; echo "went-on") 2>&1)"
check "consent, empty answer: stops" "stopped" "$(went_on "$out")"
printf '' >"${TMP}/answers"; exec 3<"${TMP}/answers"
out="$( (accept_diy; echo "went-on") 2>&1)"
check "consent, no input: stops" "stopped" "$(went_on "$out")"
answers " TAK "
out="$( (accept_diy; echo "went-on") 2>&1)"
check_contains "consent accepted ( TAK ): goes on" "went-on" "$out"
out="$( (MELLIS_ACCEPT_DIY=tak; accept_diy; echo "went-on") 2>&1)"
check_contains "consent ahead (MELLIS_ACCEPT_DIY=tak): goes on" "went-on" "$out"
answers "nie"
out="$( (MELLIS_ACCEPT_DIY=nie; accept_diy; echo "went-on") 2>&1)"
check "consent, MELLIS_ACCEPT_DIY=nie: still asks and stops" "stopped" "$(went_on "$out")"

# --- configuration code ---

check "code with dashes" "7KQ2M-9XH4T-3BWRZ-8QJ5N" "$(normalize_code '7KQ2M-9XH4T-3BWRZ-8QJ5N')"
check "code lower case, spaces, look-alikes" "7KQ2M-9XH4T-3BWRZ-80110" "$(normalize_code ' 7kq2m 9xh4t 3bwrz 8oilo ')"
normalize_code 'ABC12' >/dev/null; check "code too short" 1 $?
normalize_code '7KQ2M-9XH4T-3BWRZ-8QJ5U' >/dev/null; check "code with U (not Crockford)" 1 $?
normalize_code 'https://mellis.example.pl' >/dev/null; check "an address is not a code" 1 $?

reset_run
read_code_answer 'mellis://pair?server=https%3A%2F%2Fmellis.example.pl&code=7kq2m-9xh4t-3bwrz-8qj5n'
check "link of this server" "0 7KQ2M-9XH4T-3BWRZ-8QJ5N" "$? $PAIRING_CODE"
reset_run
read_code_answer 'Połącz: mellis://pair?server=https://mellis.example.pl/&code=7KQ2M9XH4T3BWRZ8QJ5N dzięki'
check "link inside a message, unencoded server" "0 7KQ2M-9XH4T-3BWRZ-8QJ5N" "$? $PAIRING_CODE"
reset_run
read_code_answer 'https://mellis.example.pl/pair?code=7KQ2M-9XH4T-3BWRZ-8QJ5N'
check "https link with code" "0 7KQ2M-9XH4T-3BWRZ-8QJ5N" "$? $PAIRING_CODE"
reset_run
read_code_answer 'mellis://pair?server=https://inny.example.com&code=7KQ2M-9XH4T-3BWRZ-8QJ5N'
check "link of another server" "2" "$?"

reset_run
SERVER_URL=""
read_server_answer 'mellis://pair?server=https%3A%2F%2Fmellis.example.pl&code=7KQ2M-9XH4T-3BWRZ-8QJ5N'
check "whole link as the server answer" "0 https://mellis.example.pl 7KQ2M-9XH4T-3BWRZ-8QJ5N 1" "$? $SERVER_URL $PAIRING_CODE $CODE_FROM_LINK"

# --- server address ---

check "address without scheme" "https://mellis.example.pl" "$(normalize_server_url 'Mellis.Example.pl/')"
check "address with path" "https://example.pl/mellis" "$(normalize_server_url 'https://example.pl/mellis/')"
normalize_server_url 'http://mellis.example.pl' >/dev/null; check "http refused in Release" 1 $?
OPT_CONFIGURATION="Debug"
check "http in Debug" "http://localhost:3000" "$(normalize_server_url 'http://localhost:3000')"
OPT_CONFIGURATION="Release"
normalize_server_url '7KQ2M-9XH4T-3BWRZ-8QJ5N' >/dev/null; check "a code is not an address" 1 $?

# --- server questions ---

reset_run
SERVER_URL=""
answers "mellis.example.pl" "7kq2m-9xh4t-3bwrz-8qj5n"
configure_server >/dev/null
check "asks address and code (setup open)" "https://mellis.example.pl OPEN 7KQ2M-9XH4T-3BWRZ-8QJ5N pairing" \
  "$SERVER_URL $SERVER_STATE $PAIRING_CODE $CODE_KIND"

reset_run
answers "" "ZZZZZ-YYYYY-XXXXX-WWWWW"
configure_server >/dev/null
check "the server's setup code is recognised" "setup" "$CODE_KIND"

reset_run
echo COMPLETED >"$FAKE_SERVER_DIR/setup_state"
PAIRING_CODE="7KQ2M-9XH4T-3BWRZ-8QJ5N"
answers ""
out="$(configure_server; echo "code=[$PAIRING_CODE]")"
check_contains "set-up server: no code question" "Kolejne telefony łączysz zaproszeniem" "$out"
check_contains "set-up server: remembered code dropped" "code=[]" "$out"

reset_run
answers "" ""
out="$(configure_server; echo "server=[$SERVER_URL]")"
check_contains "remembered server: shown" "Zapamiętany serwer: https://mellis.example.pl" "$out"
check_contains "remembered server: asked" "Użyć tego serwera? (T/n)" "$out"
check_contains "remembered server: Enter keeps it" "server=[https://mellis.example.pl]" "$out"

reset_run
PAIRING_CODE="7KQ2M-9XH4T-3BWRZ-8QJ5N"
answers "n" "nowy.example.pl" ""
out="$(configure_server; echo "server=[$SERVER_URL] code=[$PAIRING_CODE]")"
check_contains "remembered server refused: asks the address" "Adres serwera" "$out"
check_contains "remembered server refused: the new one" "server=[https://nowy.example.pl]" "$out"
check_contains "another server: the old code dropped" "code=[]" "$out"

reset_run
PAIRING_CODE="7KQ2M-9XH4T-3BWRZ-8QJ5N"
OPT_SERVER="https://nowy.example.pl"
answers ""
out="$(configure_server; echo "server=[$SERVER_URL] code=[$PAIRING_CODE]")"
check_contains "--server wins over the remembered one" "server=[https://nowy.example.pl]" "$out"
check_contains "--server: says which one" "Używam serwera z --server: https://nowy.example.pl (poprzednio: https://mellis.example.pl)." "$out"
check_contains "--server: no remembered-server question" "code=[]" "$out"
case "$out" in *"Użyć tego serwera"*) check "--server: not asked about the remembered one" "no" "yes" ;; *) check "--server: not asked about the remembered one" "no" "no" ;; esac

reset_run
PAIRING_CODE="7KQ2M-9XH4T-3BWRZ-8QJ5N"
OPT_SERVER="mellis.example.pl"
answers ""
out="$(configure_server; echo "code=[$PAIRING_CODE]")"
check_contains "--server of the same server keeps the code" "code=[7KQ2M-9XH4T-3BWRZ-8QJ5N]" "$out"

reset_run
answers "" "nie-kod" "7KQ2M-9XH4T-3BWRZ-8QJ5N"
out="$(configure_server)"
check_contains "invalid code asks again" "Kod konfiguracji wygląda tak: 7KQ2M-9XH4T-3BWRZ-8QJ5N" "$out"

# --- version ---

REPO="${TMP}/repo"
git init --quiet "$REPO"
git -C "$REPO" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m one
WORK_DIR="$REPO"
OPT_REF="" SERVER_VERSION=""
check "no tags: default branch" "main" "$(pick_ref 2>/dev/null)"
for tag in v1.0.0 v1.1.0 v1.10.0 v1.11.0-beta.1; do git -C "$REPO" tag "$tag"; done
SERVER_VERSION="1.1.0"
check "the server's version" "v1.1.0" "$(pick_ref 2>/dev/null)"
SERVER_VERSION="v1.0.0"
check "the server's version with v" "v1.0.0" "$(pick_ref 2>/dev/null)"
SERVER_VERSION="2.0.0"
check "unknown server version: newest release (no pre-release)" "v1.10.0" "$(pick_ref 2>/dev/null)"
check_contains "unknown server version: warning" "nie ma wydania v2.0.0" "$(pick_ref 2>&1 >/dev/null)"
SERVER_VERSION=""
check "server without a version: newest release" "v1.10.0" "$(pick_ref 2>/dev/null)"
OPT_REF="feat/x"; SERVER_VERSION="1.1.0"
check "--ref wins" "feat/x" "$(pick_ref 2>/dev/null)"
OPT_REF=""
SERVER_VERSION="1.1.0"
out="$( (choose_version) 2>&1 | sed $'s/\033\\[[0-9;]*m//g')"
check_contains "older server: says a newer version exists" "Jest nowsza wersja: 1.10.0. Najpierw zaktualizuj serwer" "$out"
check_contains "older server: offers --ref" "--ref v1.10.0" "$out"
SERVER_VERSION="1.10.0"
out="$( (choose_version) 2>&1)"
check "newest server: no notice" "0" "$(printf '%s' "$out" | grep -c 'Jest nowsza wersja' || true)"
SERVER_VERSION=""

# --- phone picker ---

reset_run
DEVICES_TSV="$(list_devices)"
check "devicectl JSON: two phones, no simulator" "2" "$(printf '%s\n' "$DEVICES_TSV" | grep -c .)"
answers "0"
out="$(choose_devices 2>&1)"
expected='1) iPhone Ani · iOS 26.1 · Wi-Fi · połączony
2) iPhone Tomka · iOS 26.0 · kabel · połączony
3) Wszystkie z listy
0) Nie instaluj, tylko zbuduj
r) Odśwież listę
Na który telefon zainstalować? [1]: '
check_contains "picker text as in the docs" "$expected" "$(printf '%s' "$out" | sed $'s/\033\\[[0-9;]*m//g')"

# --- install + pairing ---

reset_run
SERVER_STATE="OPEN"; PAIRING_CODE="7KQ2M-9XH4T-3BWRZ-8QJ5N"; CODE_KIND="pairing"
answers "3" "n"
DEVICES_TSV="$(list_devices)"
choose_devices >/dev/null
check "Wszystkie z listy selects both" "AAAA-1111 BBBB-2222 " "$SELECTED_IDS"
install_all >/dev/null
pair_first_phone >/dev/null
launches="$(grep 'process launch' "$STUB_LOG")"
check "only the first phone opens the link" "1" "$(printf '%s\n' "$launches" | grep -c -- '--payload-url')"
check_contains "link goes to the first phone" "--device AAAA-1111 --terminate-existing --payload-url mellis://pair?server=https%3A%2F%2Fmellis.example.pl&code=7KQ2M-9XH4T-3BWRZ-8QJ5N pl.mellis.AB12CD34EF" "$launches"
check "the second phone is not launched (answered n)" "0" "$(printf '%s\n' "$launches" | grep -c 'BBBB-2222')"
check_contains "result: connected" "✓ iPhone Ani: połączony z serwerem jako właściciel" "$RESULTS"
check_contains "result: the others join by invitation" "Pozostałe telefony (iPhone Tomka) dołączą zaproszeniem" "$RESULTS"
save_state
check "no code in the state after pairing" "PAIRING_CODE=''" "$(grep '^PAIRING_CODE=' "${MELLIS_STATE_DIR}/install-app.env")"
check "state file only for this user" "600" "$(stat -f '%Lp' "${MELLIS_STATE_DIR}/install-app.env")"

# The phone does not connect (code expired): the code stays, the result says what to do.
reset_run
SERVER_STATE="OPEN"; PAIRING_CODE="7KQ2M-9XH4T-3BWRZ-8QJ5N"; CODE_KIND="pairing"
DEVICES_TSV="$(list_devices)"; SELECTED_IDS="AAAA-1111"; LAUNCH_AFTER_INSTALL="no"
sed -i '' 's/echo COMPLETED >/echo OPEN >/' "${STUBS}/xcrun"
install_all >/dev/null
pair_first_phone >/dev/null
check_contains "not connected: hint" "nie widzę połączenia z serwerem" "$RESULTS"
check "not connected: code kept" "7KQ2M-9XH4T-3BWRZ-8QJ5N" "$PAIRING_CODE"
sed -i '' 's/echo OPEN >/echo COMPLETED >/' "${STUBS}/xcrun"

# The server's setup code: exchanged for the owner pairing link, the recovery code shown.
reset_run
SERVER_STATE="OPEN"; PAIRING_CODE="ZZZZZ-YYYYY-XXXXX-WWWWW"; CODE_KIND="setup"
DEVICES_TSV="$(list_devices)"; SELECTED_IDS="BBBB-2222"; LAUNCH_AFTER_INSTALL="no"
answers "Ania"
install_all >/dev/null
out="$(pair_first_phone; echo "results=$RESULTS")"
check_contains "setup code: POST /v1/setup/owner with the code" "curl POST https://mellis.example.pl/v1/setup/owner setup=ZZZZZ-YYYYY-XXXXX-WWWWW" "$(cat "$STUB_LOG")"
check_contains "setup code: the server's link opens" "--device BBBB-2222 --terminate-existing --payload-url mellis://pair?server=https%3A%2F%2Fmellis.example.pl&code=4D8PE-QW2Z7-K9M3X-6HTB1" "$(cat "$STUB_LOG")"
check_contains "setup code: recovery code shown" "Kod odzyskiwania:   RRRRR-RRRRR-RRRRR-RRRRR-RRRRR" "$out"
check_contains "setup code: connected" "✓ iPhone Tomka: połączony z serwerem jako właściciel" "$out"

# A failed install of the first phone: no pairing, the code waits.
reset_run
SERVER_STATE="OPEN"; PAIRING_CODE="7KQ2M-9XH4T-3BWRZ-8QJ5N"; CODE_KIND="pairing"
DEVICES_TSV="$(list_devices)"; SELECTED_IDS="AAAA-1111"; LAUNCH_AFTER_INSTALL="no"
PAIR_DEVICE_ID="AAAA-1111"; INSTALLED_IDS=""
pair_first_phone >/dev/null
check_contains "install failed: no pairing" "Kod konfiguracji czeka na następne uruchomienie" "$RESULTS"
check "install failed: no launch" "0" "$(grep -c 'process launch' "$STUB_LOG")"

# No code (Enter): nothing opens, the regular launch question applies.
reset_run
SERVER_STATE="OPEN"; PAIRING_CODE=""
DEVICES_TSV="$(list_devices)"; SELECTED_IDS="AAAA-1111"
answers "t"
install_all >/dev/null
pair_first_phone >/dev/null
check "no code: launched without a link" "1 0" "$(grep -c 'process launch' "$STUB_LOG") $(grep -c -- '--payload-url' "$STUB_LOG")"

printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
