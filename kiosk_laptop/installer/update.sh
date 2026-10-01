#!/usr/bin/env bash
# ServerSherpa kiosk nightly updater (laptop edition), macOS and Linux.
#
# Installed by install.sh next to docker-compose.yml and run at 03:00 local:
#   Linux: serversherpa-kiosk-update.timer, as root.
#   macOS: launch agent com.serversherpa.kiosk.update, as the Docker Desktop user.
#
# Each run: skip while scans are uploading; pull the channel image; if it
# changed, restart on it and wait for healthy; if it doesn't get healthy,
# put the previous image back. Logged to update.log (last 1 MB kept).
#
# Exit codes: 0 updated, unchanged or skipped; 1 rolled back; 2 other failure.
#
# Testing hooks: KIOSK_UPDATE_LIB=1 defines the functions without running main.
# Written for bash 3.2 (macOS's bash).
set -uo pipefail

KIOSK_DIR="${KIOSK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
UPDATE_LOG="$KIOSK_DIR/update.log"
UPDATE_STATE="$KIOSK_DIR/update-state.json"
KIOSK_CONTAINER='serversherpa-kiosk-edge-1'   # project "serversherpa-kiosk", service "edge"
PREVIOUS_TAG='serversherpa-kiosk-laptop:previous'
STATUS_URL='http://127.0.0.1:8090/edge/status'
LOG_MAX_BYTES=1048576
HEALTH_POLL_S="${HEALTH_POLL_S:-5}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
OS=$(uname -s)
PREV_IMAGE=''

# launchd and systemd start jobs with a bare PATH; Docker Desktop's CLI lives
# inside the app bundle.
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"
export PATH
DOCKER=(docker)

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

compose() { "${DOCKER[@]}" compose -f "$KIOSK_DIR/docker-compose.yml" "$@"; }

# image_ref: the image the compose file runs, else the channel's tag.
image_ref() {
  local line channel=''
  if [ -f "$KIOSK_DIR/docker-compose.yml" ]; then
    line=$(grep -E '^[[:space:]]*image:' "$KIOSK_DIR/docker-compose.yml" | head -n 1 || true)
    line="${line#*image:}"
    line="${line#"${line%%[![:space:]]*}"}"
    if [ -n "$line" ]; then printf '%s' "$line"; return 0; fi
  fi
  if [ -f "$KIOSK_DIR/config.env" ]; then
    line=$(grep -E '^KIOSK_CHANNEL=' "$KIOSK_DIR/config.env" | head -n 1 || true)
    channel="${line#*=}"
  fi
  printf 'ghcr.io/encondata/serversherpa-kiosk-laptop:%s' "${channel:-stable}"
}

# python3, but not macOS's /usr/bin/python3 stub without the command line
# tools (it would pop an install dialog at 3 a.m.).
python_bin() {
  local py
  py=$(command -v python3 2>/dev/null) || return 1
  if [ "$OS" = Darwin ] && [ "$py" = /usr/bin/python3 ]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  printf '%s' "$py"
}

status_json() { curl -fsS --max-time 10 "$STATUS_URL"; }

# outbox_busy JSON -> queued + sending (empty when it can't be read).
outbox_busy() {
  local py q s
  if py=$(python_bin); then
    printf '%s' "$1" | "$py" -c '
import json, sys
try:
    o = json.load(sys.stdin).get("outbox") or {}
    print(int(o.get("queued") or 0) + int(o.get("sending") or 0))
except Exception:
    pass
' 2>/dev/null
    return 0
  fi
  q=$(printf '%s' "$1" | sed -n 's/.*"queued"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  s=$(printf '%s' "$1" | sed -n 's/.*"sending"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$q$s" ] || return 0
  echo $(( ${q:-0} + ${s:-0} ))
}

# uploading: 0 when scans are queued or being sent. When the status call or
# its JSON fails, the kiosk counts as idle, so a dead kiosk can be repaired.
uploading() {
  local js n
  js=$(status_json 2>/dev/null) || return 1
  n=$(outbox_busy "$js")
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  [ "$n" -gt 0 ]
}

current_digest() {
  "${DOCKER[@]}" inspect --format '{{.Image}}' "$KIOSK_CONTAINER" 2>/dev/null
}

# pull_changed: 0 when the pulled channel image differs from the running one,
# 1 when it is the same, 2 when the pull fails. Sets PREV_IMAGE.
pull_changed() {
  local ref after
  ref=$(image_ref)
  PREV_IMAGE=$(current_digest || true)
  log "Pulling $ref (running ${PREV_IMAGE:-nothing})"
  if ! compose pull; then
    log "Couldn't pull $ref; the kiosk keeps running the current image."
    return 2
  fi
  after=$("${DOCKER[@]}" image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
  if [ -n "$after" ] && [ "$after" = "$PREV_IMAGE" ]; then
    log "Already up to date ($after)."
    return 1
  fi
  return 0
}

# write_state: the image to go back to. Written in place (not renamed), so on
# macOS the file the installer made for the desktop user stays theirs.
write_state() {
  { printf '{"previous_image": "%s", "image": "%s", "updated_at": "%s"}\n' \
      "$PREV_IMAGE" "$(image_ref)" "$(date '+%Y-%m-%dT%H:%M:%S%z')" >"$UPDATE_STATE"; } 2>/dev/null \
    || log "Couldn't write $UPDATE_STATE (continuing)."
}

health() {
  "${DOCKER[@]}" inspect --format '{{.State.Health.Status}}' "$KIOSK_CONTAINER" 2>/dev/null
}

# wait_healthy: checked at least once, then every HEALTH_POLL_S until the timeout.
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) status
  while :; do
    status=$(health || true)
    [ "$status" != healthy ] || return 0
    [ "$SECONDS" -lt "$deadline" ] || { log "Not healthy in time (status: ${status:-unknown})."; return 1; }
    sleep "$HEALTH_POLL_S"
  done
}

# rollback IMAGE_ID: point the channel tag back at IMAGE_ID and restart.
rollback() {
  local id="$1" ref
  ref=$(image_ref)
  if [ -z "$id" ]; then
    log "No previous image to roll back to."
    return 2
  fi
  if "${DOCKER[@]}" tag "$id" "$ref" && compose up -d; then
    log "rolled back to $id"
    return 1
  fi
  log "Rollback to $id failed."
  return 2
}

apply_update() {
  write_state
  # Keep a tag on the previous image, so the prune below can't remove it.
  if [ -n "$PREV_IMAGE" ]; then
    "${DOCKER[@]}" tag "$PREV_IMAGE" "$PREVIOUS_TAG" || log "Couldn't tag the previous image (continuing)."
  fi
  log "Starting the new image"
  if ! compose up -d; then
    log "The new image didn't start."
    rollback "$PREV_IMAGE"
    return $?
  fi
  if ! wait_healthy; then
    rollback "$PREV_IMAGE"
    return $?
  fi
  log "updated to $(current_digest || echo unknown)"
  "${DOCKER[@]}" image prune -f >/dev/null || log "Couldn't prune old images (continuing)."
  return 0
}

# trim_log: keep the last LOG_MAX_BYTES, rewriting the file in place.
trim_log() {
  local size tmp
  [ -f "$UPDATE_LOG" ] || return 0
  size=$(wc -c <"$UPDATE_LOG" | tr -d ' ')
  [ "$size" -gt "$LOG_MAX_BYTES" ] || return 0
  tmp=$(mktemp "${TMPDIR:-/tmp}/kiosk-update-log.XXXXXX") || return 0
  tail -c "$LOG_MAX_BYTES" "$UPDATE_LOG" >"$tmp" && cat "$tmp" >"$UPDATE_LOG"
  rm -f "$tmp"
}

run_update() {
  local rc
  log "---- update.sh ----"
  if uploading; then
    log "Scans are uploading — skipped; trying again tomorrow night."
    return 0
  fi
  pull_changed; rc=$?
  case "$rc" in
    0) apply_update; return $? ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
}

main() {
  local rc
  # The macOS job runs as the desktop user; if the log in the install folder
  # isn't writable, log to a temp file instead of failing.
  if ! { : >>"$UPDATE_LOG"; } 2>/dev/null; then
    UPDATE_LOG="${TMPDIR:-/tmp}/serversherpa-kiosk-update.log"
  fi
  trim_log
  run_update >>"$UPDATE_LOG" 2>&1; rc=$?
  return "$rc"
}

# Called on the last line so a partially written script runs nothing.
if [ "${KIOSK_UPDATE_LIB:-0}" != "1" ]; then
  main "$@"
  exit $?
fi
