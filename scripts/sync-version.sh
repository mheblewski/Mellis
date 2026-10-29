#!/usr/bin/env bash
# One version number for the whole release: package.json "version" (the release workflow checks the tag against it)
# is the source. This writes it into
#   - apps/ios/Version.xcconfig   MARKETING_VERSION of the app and the widget ("Mellis 1.0.0 (build N)" in O aplikacji)
#   - scripts/install-server.sh   MELLIS_DEFAULT_VERSION, the image the installer pins
#   - every installer link (README, docs, docs-site, deploy, the installers' headers):
#     https://raw.githubusercontent.com/mheblewski/Mellis/vX.Y.Z/scripts/install-{server,app}.sh, the release tag,
#     so a copied command runs the reviewed release, not whatever is on main
# Usage: scripts/sync-version.sh          write
#        scripts/sync-version.sh --check  exit 1 when a file differs (CI, release workflow)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$root/package.json" | head -n 1)"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package.json version is not X.Y.Z: '$version'" >&2
  exit 1
fi

xcconfig="$root/apps/ios/Version.xcconfig"
expected_xcconfig="// Written by scripts/sync-version.sh from package.json \"version\"; do not edit by hand.
MELLIS_VERSION = $version
MARKETING_VERSION = \$(MELLIS_VERSION)"
installer="$root/scripts/install-server.sh"
expected_installer_line="MELLIS_DEFAULT_VERSION=\"$version\""

# Installer links: raw.githubusercontent.com/mheblewski/Mellis/<ref>/scripts/install-(server|app).sh
link_pattern='raw\.githubusercontent\.com/mheblewski/Mellis/[^/[:space:])"]+/scripts/install-(server|app)\.sh'
link_files() {
  local candidates=("$root/README.md" "$root/scripts" "$root/docs" "$root/docs-site/docs" "$root/deploy")
  local existing=() path
  for path in "${candidates[@]}"; do [ -e "$path" ] && existing+=("$path"); done
  grep -rlE --exclude-dir=node_modules --exclude-dir=product --exclude-dir=history "$link_pattern" "${existing[@]}" 2>/dev/null || true
}

if [ "${1:-}" = "--check" ]; then
  status=0
  if [ "$(cat "$xcconfig" 2>/dev/null)" != "$expected_xcconfig" ]; then
    echo "apps/ios/Version.xcconfig is not $version: run scripts/sync-version.sh" >&2
    status=1
  fi
  if ! grep -qx "$expected_installer_line" "$installer"; then
    echo "scripts/install-server.sh MELLIS_DEFAULT_VERSION is not $version: run scripts/sync-version.sh" >&2
    status=1
  fi
  stale="$(link_files | while read -r file; do grep -oE "$link_pattern" "$file" | grep -v "/Mellis/v$version/" | sed "s|^|${file#"$root"/}: |"; done)"
  if [ -n "$stale" ]; then
    printf 'installer links not at v%s: run scripts/sync-version.sh\n%s\n' "$version" "$stale" >&2
    status=1
  fi
  exit "$status"
fi

printf '%s\n' "$expected_xcconfig" > "$xcconfig"
tmp="$(mktemp)"
sed "s/^MELLIS_DEFAULT_VERSION=\".*\"$/$expected_installer_line/" "$installer" > "$tmp"
cat "$tmp" > "$installer"
rm -f "$tmp"
link_files | while read -r file; do
  V="$version" perl -pi -e 's#(raw\.githubusercontent\.com/mheblewski/Mellis/)[^/\s)"]+(/scripts/install-(?:server|app)\.sh)#$1v$ENV{V}$2#g' "$file"
done
echo "Mellis $version"
