#!/usr/bin/env bash
# ServerSherpa kiosk nightly updater (laptop edition), macOS and Linux.
#
# Installed by install.sh next to docker-compose.yml and run at 03:00 local:
#   Linux: serversherpa-kiosk-update.timer, as root.
#   macOS: launch agent com.serversherpa.kiosk.update, as the Docker Desktop user.
#
# Each run: finish off an update a crash or reboot interrupted; skip while
# scans are uploading; pull the channel image; if it changed (and isn't one
# that already failed), restart on it and wait for healthy; if it doesn't get
# healthy, put the previous image back and remember the bad one.
# Logged to update.log (last 1 MB kept).
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
PREV_IMAGE=''      # running before this update
NEW_IMAGE=''       # pulled by this update
# update-state.json, read by load_state and written by write_state.
STATE_PREVIOUS=''  # the image to go back to
STATE_REJECTED=''  # an image that failed its health check; not tried again
STATE_PHASE=''     # updating while an update is under way, else done
IMAGE_SOURCE_LABEL='org.opencontainers.image.source=https://github.com/encondata/BaseCampV3'

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

image_id() { "${DOCKER[@]}" image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

# Docker Desktop's containerd image store can't find an image by its ID once
# it has no name left, even while a container runs it, so images are named
# before a pull moves the channel tag, and put back by name.

# keep_previous ID REF: tag the running image ID as :previous, from REF while
# REF still names it (before the pull), else by ID (classic store).
keep_previous() {
  local id="$1" ref="$2"
  if [ "$(image_id "$ref")" = "$id" ]; then
    "${DOCKER[@]}" tag "$ref" "$PREVIOUS_TAG" && return 0
  fi
  "${DOCKER[@]}" tag "$id" "$PREVIOUS_TAG" && return 0
  log "Couldn't tag the previous image $id as $PREVIOUS_TAG (continuing)."
  return 1
}

# retag ID REF: put image ID back on REF, from :previous when it holds that
# image, else by ID (logging why).
retag() {
  local id="$1" ref="$2" kept
  kept=$(image_id "$PREVIOUS_TAG")
  if [ "$kept" = "$id" ]; then
    "${DOCKER[@]}" tag "$PREVIOUS_TAG" "$ref" && return 0
    log "Couldn't tag $ref from $PREVIOUS_TAG; trying $id by ID."
  elif [ -n "$kept" ]; then
    log "$PREVIOUS_TAG holds $kept, not $id; tagging $id by ID."
  else
    log "$PREVIOUS_TAG doesn't exist; tagging $id by ID."
  fi
  "${DOCKER[@]}" tag "$id" "$ref"
}

# pull_changed: 0 when the pulled channel image differs from the running one,
# 1 when it is the same or was rejected before, 2 when the pull fails.
# Sets PREV_IMAGE and NEW_IMAGE.
pull_changed() {
  local ref
  ref=$(image_ref)
  PREV_IMAGE=$(current_digest || true)
  # Before the pull, while the channel tag still names the running image.
  [ -z "$PREV_IMAGE" ] || keep_previous "$PREV_IMAGE" "$ref" || true
  log "Pulling $ref (running ${PREV_IMAGE:-nothing})"
  if ! compose pull; then
    log "Couldn't pull $ref; the kiosk keeps running the current image."
    return 2
  fi
  NEW_IMAGE=$("${DOCKER[@]}" image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
  if [ -n "$NEW_IMAGE" ] && [ "$NEW_IMAGE" = "$PREV_IMAGE" ]; then
    log "Already up to date ($NEW_IMAGE)."
    return 1
  fi
  if [ -n "$NEW_IMAGE" ] && [ "$NEW_IMAGE" = "$STATE_REJECTED" ]; then
    log "skipping $NEW_IMAGE — it failed its health check before"
    # Point the channel tag back at the running image, so nothing (compose
    # included) recreates the container on the rejected one.
    if [ -n "$PREV_IMAGE" ]; then
      retag "$PREV_IMAGE" "$ref" || log "Couldn't re-tag $ref to $PREV_IMAGE."
      return 1
    fi
    start_without_container "$ref" || return 2
    return 1
  fi
  return 0
}

# start_without_container REF: no kiosk container is running and the channel
# image is the rejected one. Start the kept :previous image if there is one,
# else the rejected image anyway: a kiosk that might work beats no kiosk.
start_without_container() {
  local ref="$1" prev
  prev=$(image_id "$PREVIOUS_TAG")
  if [ -z "$prev" ] || [ "$prev" = "$NEW_IMAGE" ]; then
    log "No kiosk container is running and no earlier image is kept; starting it anyway ($NEW_IMAGE)."
  elif "${DOCKER[@]}" tag "$PREVIOUS_TAG" "$ref"; then
    log "No kiosk container is running; starting the kept previous image $prev."
  else
    log "Couldn't re-tag $ref to the kept previous image $prev; starting it anyway ($NEW_IMAGE)."
  fi
  compose up -d && return 0
  log "The kiosk didn't start."
  return 1
}

# state_value KEY: a string value from update-state.json (written by write_state).
state_value() {
  [ -f "$UPDATE_STATE" ] || return 0
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$UPDATE_STATE" 2>/dev/null | head -n 1
}

load_state() {
  STATE_PREVIOUS=$(state_value previous_image)
  STATE_REJECTED=$(state_value rejected_image)
  STATE_PHASE=$(state_value phase)
}

# write_state: written in place (not renamed), so on macOS the file the
# installer made for the desktop user stays theirs.
write_state() {
  { printf '{"previous_image": "%s", "image": "%s", "rejected_image": "%s", "phase": "%s", "updated_at": "%s"}\n' \
      "$STATE_PREVIOUS" "$(image_ref)" "$STATE_REJECTED" "$STATE_PHASE" \
      "$(date '+%Y-%m-%dT%H:%M:%S%z')" >"$UPDATE_STATE"; } 2>/dev/null \
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
# The caller sets STATE_REJECTED to the image that failed. Only a rollback
# that worked ends the update; after a failure the phase stays "updating",
# so the next run tries again.
rollback() {
  local id="$1" ref rc=2
  ref=$(image_ref)
  if [ -z "$id" ]; then
    log "No previous image to roll back to."
  elif retag "$id" "$ref" && compose up -d; then
    log "rolled back to $id"
    rc=1
    STATE_PHASE='done'
  else
    log "Rollback to $id failed; the next run tries again."
  fi
  write_state
  return "$rc"
}

docker_up() { "${DOCKER[@]}" info >/dev/null 2>&1; }

# recover_interrupted: an update that never finished (crash, reboot, power
# loss) left a container that isn't healthy: go back to the previous image.
# 0 = nothing to recover (or it came up after all); else the rollback's code.
recover_interrupted() {
  local cur rc
  [ "$STATE_PHASE" = updating ] && [ -n "$STATE_PREVIOUS" ] || return 0
  # Docker being down is not a missing container: leave everything for later.
  if ! docker_up; then
    log "Docker isn't answering; an unfinished update is left for the next run."
    return 2
  fi
  cur=$(current_digest || true)
  if [ "$cur" = "$STATE_PREVIOUS" ]; then
    # Interrupted before the new image replaced the old one (or after a
    # rollback that worked): the previous image is running, so it's over.
    STATE_PHASE='done'
    write_state
    return 0
  fi
  if wait_healthy; then
    STATE_PHASE='done'
    write_state
    return 0
  fi
  log "The last update didn't finish and the kiosk isn't healthy."
  # No container means no image to blame: keep the one rejected before.
  [ -z "$cur" ] || STATE_REJECTED="$cur"
  rollback "$STATE_PREVIOUS"; rc=$?
  [ "$rc" != 1 ] || log "recovered from an interrupted update"
  return "$rc"
}

apply_update() {
  STATE_PREVIOUS="$PREV_IMAGE"
  STATE_REJECTED=''   # a different, newer image: forget the rejected one
  STATE_PHASE=updating
  write_state
  # :previous (tagged before the pull) keeps the prune below off the previous
  # image; tag it now if that didn't work.
  if [ -n "$PREV_IMAGE" ] && [ "$(image_id "$PREVIOUS_TAG")" != "$PREV_IMAGE" ]; then
    "${DOCKER[@]}" tag "$PREV_IMAGE" "$PREVIOUS_TAG" || log "Couldn't tag the previous image (continuing)."
  fi
  log "Starting the new image"
  if ! compose up -d; then
    log "The new image didn't start."
    STATE_REJECTED="$NEW_IMAGE"
    rollback "$PREV_IMAGE"
    return $?
  fi
  if ! wait_healthy; then
    STATE_REJECTED="$NEW_IMAGE"
    rollback "$PREV_IMAGE"
    return $?
  fi
  STATE_PHASE='done'
  write_state
  log "updated to $(current_digest || echo unknown)"
  # Only the kiosk's own untagged images; :previous is tagged, so it stays.
  "${DOCKER[@]}" image prune -f --filter "label=$IMAGE_SOURCE_LABEL" >/dev/null \
    || log "Couldn't prune old images (continuing)."
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
  load_state
  recover_interrupted; rc=$?
  [ "$rc" = 0 ] || return "$rc"
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
