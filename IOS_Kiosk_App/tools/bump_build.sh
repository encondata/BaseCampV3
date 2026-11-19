#!/usr/bin/env bash
# Sets the kiosk app's build number (CURRENT_PROJECT_VERSION, which becomes
# CFBundleVersion) in every target and configuration of the Xcode project.
# Only project.pbxproj is edited. MARKETING_VERSION is left alone.
#
#   IOS_Kiosk_App/tools/bump_build.sh        the current build + 1
#   IOS_Kiosk_App/tools/bump_build.sh 7      exactly 7 (must be higher than now)
#
# Every IPA uploaded to the Devices site needs a higher build than any build
# ever uploaded there, deleted versions included.
set -euo pipefail

usage() {
    echo "usage: $(basename "$0") [N]   set CURRENT_PROJECT_VERSION to N, or to the current value + 1"
}

die() {
    echo "bump_build: $*" >&2
    exit 1
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pbxproj="$here/../ServerSherpa Kiosk/ServerSherpa Kiosk.xcodeproj/project.pbxproj"
[[ -f "$pbxproj" ]] || die "can't find $pbxproj"

# The Devices site takes a first build part of at most 11 digits
# (devices/api packages/versions.py).
max_digits=11

total="$(grep -c 'CURRENT_PROJECT_VERSION = ' "$pbxproj" || true)"
[[ "$total" -gt 0 ]] || die "project.pbxproj has no CURRENT_PROJECT_VERSION"
plain="$(grep -c -E '^[[:space:]]*CURRENT_PROJECT_VERSION = [0-9]+;$' "$pbxproj" || true)"
[[ "$plain" -eq "$total" ]] \
    || die "not every CURRENT_PROJECT_VERSION in project.pbxproj is a plain integer; fix them by hand first"

values="$(sed -n -E 's/^[[:space:]]*CURRENT_PROJECT_VERSION = ([0-9]+);$/\1/p' "$pbxproj" | sort -u)"
if [[ "$(printf '%s\n' "$values" | wc -l | tr -d ' ')" -ne 1 ]]; then
    die "the CURRENT_PROJECT_VERSION values disagree ($(printf '%s\n' "$values" | paste -sd ' ' -)); make them match by hand first"
fi
[[ "${#values}" -le "$max_digits" ]] || die "the current build $values is longer than $max_digits digits"
current=$((10#$values))

if [[ $# -eq 1 ]]; then
    new="$1"
    [[ "$new" =~ ^[1-9][0-9]*$ ]] || die "'$new' isn't a positive integer"
    [[ "${#new}" -le "$max_digits" ]] || die "$new is longer than $max_digits digits; the Devices site won't take it"
    new=$((10#$new))
    [[ "$new" -gt "$current" ]] || die "$new isn't greater than the current build $current"
else
    new=$((current + 1))
    [[ "${#new}" -le "$max_digits" ]] || die "$new is longer than $max_digits digits; the Devices site won't take it"
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/bump_build.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
sed -E "s/^([[:space:]]*CURRENT_PROJECT_VERSION = )[0-9]+;$/\1$new;/" "$pbxproj" > "$tmp"

after="$(grep -c -E "^[[:space:]]*CURRENT_PROJECT_VERSION = $new;$" "$tmp" || true)"
[[ "$after" -eq "$total" ]] || die "the edit didn't reach every CURRENT_PROJECT_VERSION; project.pbxproj is unchanged"
# Write in place, so the file keeps its permissions.
cat "$tmp" > "$pbxproj"

echo "CURRENT_PROJECT_VERSION $current -> $new ($total settings in project.pbxproj)"
