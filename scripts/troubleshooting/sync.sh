#!/usr/bin/env bash
# Mirror the shared troubleshooting content (*.json and *.png only) from the web kiosk's
# folder into the Android assets and iOS resources, removing files no longer in the source.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/kiosk/src/troubleshooting"
DESTS=(
  "$ROOT/Android_Kiosk_App/app/src/main/assets/troubleshooting"
  "$ROOT/IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Resources/Troubleshooting"
)
for dest in "${DESTS[@]}"; do
  mkdir -p "$dest"
  find "$dest" -maxdepth 1 -type f -delete
  for f in "$SRC"/*.json "$SRC"/*.png; do
    [ -e "$f" ] && cp "$f" "$dest/"
  done
  echo "synced $(find "$dest" -maxdepth 1 -type f | wc -l | tr -d ' ') files to $dest"
done
