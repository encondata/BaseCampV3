#!/usr/bin/env bash
# copy_to_unas.sh — copy the source tree (and every other file) to the UNAS
# archive share, leaving out build output, installed dependencies and caches:
#
#   ./copy_to_unas.sh            copy (only new/changed files are sent)
#   ./copy_to_unas.sh --dry-run  list what would be copied, change nothing
#
# Destination: smb://HSL-UNAS-Pro-2._smb._tcp.local/Jimmys_Archive/BaseCampV3-Gold/
# Mount the share in Finder first (Go › Connect to Server…); it appears at
# /Volumes/Jimmys_Archive. Nothing is deleted on the share — files removed
# here stay in the archive.
#
# .claude/worktrees is skipped too: every worktree's branch is already in .git.

set -euo pipefail
cd "$(dirname "$0")"

SHARE="/Volumes/Jimmys_Archive"
DEST="$SHARE/BaseCampV3-Gold/"

EXCLUDES=(
  # Claude worktrees (their branches live in .git)
  /.claude/worktrees/
  # JS / Python dependencies and caches
  node_modules/ .venv/ venv/ __pycache__/ '*.pyc' .pytest_cache/
  .mypy_cache/ .ruff_cache/ '*.egg-info/'
  # Web build output
  dist/
  # Gradle / Android build output
  build/ .gradle/ .kotlin/ .cxx/ .externalNativeBuild/ '*.apk' '*.aab'
  # Xcode / iOS build output
  .derived/ DerivedData/ xcuserdata/ .build/ Pods/ '*.xcarchive' '*.ipa'
  # Finder metadata
  .DS_Store
)

DRY_RUN=()
case "${1:-}" in
  "") ;;
  -n|--dry-run) DRY_RUN=(-n --out-format='%n') ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 1
    ;;
esac

if ! mount | grep -q " on $SHARE (smbfs"; then
  echo "error: $SHARE isn't mounted — connect to smb://HSL-UNAS-Pro-2._smb._tcp.local/Jimmys_Archive in Finder first." >&2
  exit 1
fi

exclude_args=()
for pattern in "${EXCLUDES[@]}"; do
  exclude_args+=(--exclude="$pattern")
done

# -rlt rather than -a: SMB can't keep owner/group/permissions.
echo "==> copying $(pwd) to $DEST…"
rsync -rlt "${DRY_RUN[@]}" "${exclude_args[@]}" ./ "$DEST"
echo "==> done."
