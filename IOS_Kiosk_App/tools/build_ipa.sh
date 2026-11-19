#!/usr/bin/env bash
# Builds the crew IPA for the Devices site (devices.dev.serversherpa.com): an
# optimized Release archive of the kiosk app built with DEV_API, so it
# defaults to https://api.dev.serversherpa.com. It packages the app as
# IOS_Kiosk_App/.derived/ipa/ServerSherpa-Kiosk-<version>-<build>.ipa and
# checks it. It never uploads anything: upload the IPA on the Devices site,
# which re-signs it with its own Ad Hoc profile.
#
#   IOS_Kiosk_App/tools/build_ipa.sh
#
# Raise the build first with tools/bump_build.sh: every upload needs a higher
# build than any build ever uploaded (deleted versions count).
set -euo pipefail
# An exported CDPATH would make the cd below print the path it went to.
unset CDPATH

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    echo "usage: $(basename "$0")   archive Release with DEV_API, package and check the Devices site IPA"
    exit 0
fi
[[ $# -eq 0 ]] || { echo "usage: $(basename "$0") [--help]" >&2; exit 2; }

die() {
    echo "build_ipa: $*" >&2
    exit 1
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_root="$(cd "$here/.." && pwd)"                    # IOS_Kiosk_App
project="$app_root/ServerSherpa Kiosk/ServerSherpa Kiosk.xcodeproj"
pbxproj="$project/project.pbxproj"
scheme="ServerSherpa Kiosk"
bundle_id="Server-Sherpas.ServerSherpa-Kiosk"
dev_api="https://api.dev.serversherpa.com"
out="$app_root/.derived/ipa"
archive="$out/ServerSherpa Kiosk.xcarchive"
derived="$out/DerivedData"
log="$out/archive.log"
# The Devices site refuses uploads over this (devices/api catalog.py UPLOAD_LIMIT).
upload_limit=$((500 * 1024 * 1024))
# The only entitlements the Devices site's Ad Hoc profile is sure to cover.
# Anything else is a capability that must be turned on for the App ID first.
allowed_entitlements=(application-identifier com.apple.developer.team-identifier
                      get-task-allow keychain-access-groups)

# xcode-select may point at the Command Line Tools.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
xcodebuild="$DEVELOPER_DIR/usr/bin/xcodebuild"
[[ -x "$xcodebuild" ]] || die "no xcodebuild under DEVELOPER_DIR=$DEVELOPER_DIR"
[[ -f "$pbxproj" ]] || die "can't find $pbxproj"

# The one build number every target and configuration agrees on.
builds="$(sed -n -E 's/^[[:space:]]*CURRENT_PROJECT_VERSION = ([^;]*);$/\1/p' "$pbxproj" | sort -u)"
[[ -n "$builds" && "$(printf '%s\n' "$builds" | wc -l | tr -d ' ')" -eq 1 ]] \
    || die "the CURRENT_PROJECT_VERSION values in project.pbxproj disagree; run tools/bump_build.sh N"
project_build="$builds"

# The commit this build comes from, taken before building.
commit="$(git -C "$app_root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
dirty="$(git -C "$app_root" status --porcelain -- . 2>/dev/null || true)"

mkdir -p "$out"
rm -rf "$archive"
# A failed run leaves no IPA of this build, not even one from an earlier run.
rm -f "$out/ServerSherpa-Kiosk-"*"-$project_build.ipa"
echo "Archiving Release with DEV_API (build $project_build); log: $log"
# $(inherited) keeps any condition the Release configuration ever sets
# (today it sets none). It is for xcodebuild to expand, not the shell.
# shellcheck disable=SC2016
if ! "$xcodebuild" archive \
    -project "$project" \
    -scheme "$scheme" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$archive" \
    -derivedDataPath "$derived" \
    -allowProvisioningUpdates \
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEV_API' \
    > "$log" 2>&1; then
    echo "--- errors from $log:" >&2
    grep -E '(error|ERROR|fatal):' "$log" | sort -u | tail -n 20 >&2 || true
    echo "--- last lines of $log:" >&2
    tail -n 15 "$log" >&2
    die "the archive failed"
fi

shopt -s nullglob
archived=("$archive/Products/Applications/"*.app)
[[ ${#archived[@]} -eq 1 ]] || die "expected one app in $archive/Products/Applications, found ${#archived[@]}"
app_name="$(basename "${archived[0]}")"

stage="$(mktemp -d "${TMPDIR:-/tmp}/build_ipa_stage.XXXXXX")"
check="$(mktemp -d "${TMPDIR:-/tmp}/build_ipa_check.XXXXXX")"
trap 'rm -rf "$stage" "$check"' EXIT

plist_value() {   # plist_value <plist> <key>
    /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null || true
}

# Package: Payload/<App>.app, symlinks kept (-y), no .DS_Store. /usr/bin/zip
# writes no __MACOSX folder. The IPA is zipped in the stage directory and
# gets its final name only after every check below passes, so a failed run
# never leaves an IPA that looks ready to upload.
mkdir "$stage/Payload"
cp -RP "${archived[0]}" "$stage/Payload/"
version="$(plist_value "$stage/Payload/$app_name/Info.plist" CFBundleShortVersionString)"
build="$(plist_value "$stage/Payload/$app_name/Info.plist" CFBundleVersion)"
[[ -n "$version" && -n "$build" ]] || die "the archived app's Info.plist has no version or build"
ipa="$out/ServerSherpa-Kiosk-$version-$build.ipa"
rm -f "$ipa"      # an earlier IPA of this build isn't from this archive
pending="$stage/pending.ipa"
(cd "$stage" && /usr/bin/zip -qry "$pending" Payload -x '*.DS_Store')

# Check the IPA itself, unzipped fresh.
fail() {
    echo "build_ipa: the IPA failed a check: $*" >&2
    echo "build_ipa: no IPA was written. The archive is in $archive" >&2
    exit 1
}
/usr/bin/unzip -q "$pending" -d "$check"
apps=("$check/Payload/"*.app)
[[ ${#apps[@]} -eq 1 ]] || fail "expected exactly one Payload/*.app, found ${#apps[@]}"
app="${apps[0]}"
info="$app/Info.plist"
[[ -f "$info" ]] || fail "Payload/$(basename "$app") has no Info.plist"

got="$(plist_value "$info" CFBundleIdentifier)"
[[ "$got" == "$bundle_id" ]] || fail "CFBundleIdentifier is '$got', not $bundle_id"
got="$(plist_value "$info" CFBundleVersion)"
[[ "$got" == "$project_build" ]] || fail "CFBundleVersion is '$got', but project.pbxproj says $project_build"
got="$(plist_value "$info" DTPlatformName)"
[[ "$got" == "iphoneos" ]] || fail "DTPlatformName is '$got', not iphoneos (not a device build)"

# DEV_API reached the Swift compiler (only swiftc gets -D conditions)...
grep -qE -- '(^|[[:space:]])-D ?DEV_API([[:space:]]|$)' "$log" \
    || fail "no Swift compile in $log was given -DDEV_API"
# ...and the binary carries the dev API URL, which only a DEBUG or DEV_API
# build does (KioskBuildConfig.swift; the literal appears nowhere else).
executable="$(plist_value "$info" CFBundleExecutable)"
[[ -n "$executable" && -f "$app/$executable" ]] || fail "the main executable '$executable' isn't in the app"
LC_ALL=C grep -aqF "$dev_api" "$app/$executable" \
    || fail "the executable doesn't contain $dev_api, so DEV_API didn't take effect"

# The signed entitlements of the app and of each app extension: the Devices
# site checks both against the app's one profile (frameworks carry none).
check_entitlements() {   # check_entitlements <bundle> <name for messages>
    local ents_xml extra
    if ! ents_xml="$(/usr/bin/codesign -d --entitlements - --xml "$1" 2>/dev/null)"; then
        fail "codesign can't read the signature of $2"
    fi
    extra="$(printf '%s' "$ents_xml" | /usr/bin/python3 -I -c '
import plistlib, sys
data = sys.stdin.buffer.read()
keys = plistlib.loads(data) if data.strip() else {}
print(" ".join(sorted(set(keys) - set(sys.argv[1:]))))
' "${allowed_entitlements[@]}")" || fail "the signed entitlements of $2 can't be parsed"
    [[ -z "$extra" ]] || fail "$2 has entitlements beyond the basic ones: $extra. Turn that capability on for the App ID $bundle_id in Apple's developer site first, or the Devices site's re-sign fails."
}
check_entitlements "$app" "the app"
for appex in "$app/PlugIns/"*.appex; do
    check_entitlements "$appex" "PlugIns/$(basename "$appex")"
done

size="$(/usr/bin/stat -f %z "$pending")"
[[ "$size" -le "$upload_limit" ]] || fail "it is $size bytes; the Devices site takes at most 500 MB ($upload_limit bytes)"

mv -f "$pending" "$ipa"

echo
echo "IPA:      $ipa"
echo "Version:  $version"
echo "Build:    $build"
echo "Size:     $(awk -v b="$size" 'BEGIN { printf "%.1f MB (%d bytes)", b / 1048576, b }')"
echo "Commit:   $commit"
echo "API:      defaults to $dev_api (DEV_API)"
if [[ -n "$dirty" ]]; then
    echo "Warning:  IOS_Kiosk_App has uncommitted changes, so this build isn't exactly commit $commit."
fi
echo "Reminder: build $build must be higher than every build already uploaded to the Devices site,"
echo "          deleted versions included. Raise it with tools/bump_build.sh."
