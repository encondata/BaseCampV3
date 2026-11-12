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
# Then, whatever happened above, hostnet.sh and launch.sh (and, on Linux,
# kiosk_session.py) are refreshed from the commit the running image was built
# from (its revision label; main for older images), or from the ref pinned in
# config.env (never update.sh itself); a failure there never changes the
# exit code. On macOS the folder is root's and only those two files belong to
# the desktop user (install.sh), so they are overwritten in place; where even
# that isn't possible the log says to re-run the install command.
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

# ── Helper scripts ────────────────────────────────────────────────────
# REVISION_LABEL: the label the kiosk-laptop-image workflow (and the
# Dockerfile's KIOSK_REVISION build arg) sets to the full commit of the build.
REVISION_LABEL='org.opencontainers.image.revision'

# is_commit_sha VALUE: 0 when VALUE is exactly 40 lowercase hex characters.
is_commit_sha() {
  [ "${#1}" -eq 40 ] || return 1
  # Spelled out: in bash 3.2 a range like a-f can match capitals under some locales.
  case "$1" in *[!0123456789abcdef]*) return 1 ;; esac
  return 0
}

# running_revision: the revision label of the image the kiosk container runs
# now (empty when there is no container or no label). The image is inspected
# by the container's image ID; where that fails (Docker Desktop's containerd
# store can't find an image by ID once no name is left), the container's own
# labels, which it inherits from its image, are read instead.
running_revision() {
  local id fmt="{{index .Config.Labels \"$REVISION_LABEL\"}}"
  id=$(current_digest || true)
  [ -n "$id" ] || return 0
  "${DOCKER[@]}" image inspect --format "$fmt" "$id" 2>/dev/null \
    || "${DOCKER[@]}" inspect --format "$fmt" "$KIOSK_CONTAINER" 2>/dev/null \
    || true
}

# installer_ref: the git ref the helper scripts are refreshed from. The log
# line saying which and why goes to stderr, so $(installer_ref) stays the ref.
#   config.env's KIOSK_INSTALLER_REF (written by install.sh) empty or main,
#   the default: the commit the running kiosk image was built from (its
#   revision label), so the scripts match the app the laptop runs on its
#   channel. A label that isn't exactly 40 lowercase hex characters (images
#   built before the label existed, local builds) means main.
#   any other plain ref (letters, digits, . _ / -, no ".."): a developer
#   pinned it, and it wins over the label.
#   anything else: logged, and main is used.
installer_ref() {
  local line='' ref='' rev
  if [ -f "$KIOSK_DIR/config.env" ]; then
    line=$(grep -E '^KIOSK_INSTALLER_REF=' "$KIOSK_DIR/config.env" | head -n 1 || true)
    ref="${line#*=}"
  fi
  case "$ref" in
    ''|main)
      rev=$(running_revision)
      if is_commit_sha "$rev"; then
        log "Helper scripts follow the running image's revision label ($rev)." >&2
        ref="$rev"
      else
        log "Helper scripts: the running kiosk image has no usable revision label ($(printf '%s' "${rev:-none}" | tr -cd 'A-Za-z0-9._-' | cut -c1-64)); using main." >&2
        ref=main
      fi ;;
    *[!A-Za-z0-9._/-]*|*..*) log "Ignoring the installer ref in config.env (not a plain git ref); using main." >&2; ref=main ;;
    *) log "Helper scripts use the ref pinned by KIOSK_INSTALLER_REF in config.env ($ref)." >&2 ;;
  esac
  printf '%s' "$ref"
}

# file_mode FILE: its octal permission bits (755 when they can't be read).
file_mode() {
  local m
  m=$(stat -f '%Lp' "$1" 2>/dev/null) || m=$(stat -c '%a' "$1" 2>/dev/null) || m=''
  case "$m" in ''|*[!0-7]*) m=755 ;; esac
  printf '%s' "$m"
}

# fetch_helper NAME DEST: KIOSK_TEMPLATE_DIR's copy (tests), else download.
# HELPER_REF is the ref refresh_helpers settled on.
fetch_helper() {
  local name="$1" dest="$2"
  if [ -n "${KIOSK_TEMPLATE_DIR:-}" ]; then
    cp "$KIOSK_TEMPLATE_DIR/$name" "$dest"
  else
    curl -fsSL --max-time 30 \
      "https://raw.githubusercontent.com/encondata/BaseCampV3/$HELPER_REF/kiosk_laptop/installer/$name" -o "$dest"
  fi
}

# helper_shebang NAME: the first line a published helper must have.
helper_shebang() {
  case "$1" in
    *.py) printf '#!/usr/bin/env python3' ;;
    *) printf '#!/usr/bin/env bash' ;;
  esac
}

# helper_syntax_ok NAME FILE: bash -n for a shell script; for a .py, it must
# parse (python3's ast; no python3 counts as a failure).
helper_syntax_ok() {
  local py
  case "$1" in
    *.py)
      py=$(python_bin) || return 1
      "$py" -c 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$2" >/dev/null 2>&1 ;;
    *) bash -n "$2" 2>/dev/null ;;
  esac
}

# refresh_helper NAME: replace $KIOSK_DIR/NAME with the published copy when it
# is a sound script that differs. 0 = replaced; 1 = unchanged or failed (the
# old file stays; one log line says which).
# Where it can write decides how:
#   the folder is writable (Linux, root): a temp file in it, mv over the file;
#   only the file is writable (macOS: the folder is root's, install.sh gave the
#   desktop user these two files): a temp file in TMPDIR, then overwritten in
#   place, so its mode and owner stay;
#   neither: say so, before downloading anything.
refresh_helper() {
  local name="$1" cur="$KIOSK_DIR/$1" tmp inplace=0 want
  if [ -w "$KIOSK_DIR" ]; then
    tmp=$(mktemp "$KIOSK_DIR/.$name.XXXXXX" 2>/dev/null) || { log "$name: failed (can't write to $KIOSK_DIR)"; return 1; }
  elif [ -f "$cur" ] && [ -w "$cur" ]; then
    inplace=1
    tmp=$(mktemp "${TMPDIR:-/tmp}/kiosk-helper.XXXXXX" 2>/dev/null) || { log "$name: failed (no temp file)"; return 1; }
  else
    log "can't update $name: re-run the install command"
    return 1
  fi
  if ! fetch_helper "$name" "$tmp" 2>/dev/null; then
    rm -f "$tmp"; log "$name: failed (download)"; return 1
  fi
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"; log "$name: failed (empty)"; return 1
  fi
  want=$(helper_shebang "$name")
  if [ "$(head -n 1 "$tmp")" != "$want" ]; then
    rm -f "$tmp"; log "$name: failed (no ${want##* } shebang)"; return 1
  fi
  if ! helper_syntax_ok "$name" "$tmp"; then
    rm -f "$tmp"; log "$name: failed (syntax error)"; return 1
  fi
  if [ -f "$cur" ] && cmp -s "$tmp" "$cur"; then
    rm -f "$tmp"; log "$name: unchanged"; return 1
  fi
  if [ "$inplace" = 1 ]; then
    if ! cat "$tmp" >"$cur" 2>/dev/null; then
      rm -f "$tmp"; log "$name: failed (write)"; return 1
    fi
    rm -f "$tmp"
  else
    if { [ ! -f "$cur" ] && chmod 755 "$tmp"; } || { [ -f "$cur" ] && chmod "$(file_mode "$cur")" "$tmp"; }; then :; else
      rm -f "$tmp"; log "$name: failed (chmod)"; return 1
    fi
    if ! mv -f "$tmp" "$cur"; then
      rm -f "$tmp"; log "$name: failed (replace)"; return 1
    fi
  fi
  log "$name: refreshed"
  return 0
}

# run_hostnet_limited: hostnet.sh once, killed after HOSTNET_LIMIT_S (30)
# seconds (macOS has no timeout). 0 = it exited 0.
run_hostnet_limited() {
  local pid n=0 limit="${HOSTNET_LIMIT_S:-30}" rc=0
  "$KIOSK_DIR/hostnet.sh" >/dev/null 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$n" -ge "$limit" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      log "hostnet.sh: the run after the refresh didn't finish in ${limit}s; stopped it (continuing)"
      return 1
    fi
    sleep 1
    n=$((n + 1))
  done
  wait "$pid" || rc=$?
  [ "$rc" = 0 ] || log "hostnet.sh: the run after the refresh failed (continuing)"
  return "$rc"
}

# refresh_helpers: hostnet.sh and launch.sh, and on Linux kiosk_session.py
# (never update.sh itself). A refreshed hostnet.sh runs once now, so what it
# reports shows up without waiting for its next run; a refreshed
# kiosk_session.py takes effect at the next sign-in. Nothing here changes the
# updater's exit code. setup-kiosk.sh (the Set up kiosk icon's runner) isn't
# refreshed: it downloads setup.sh fresh on every run, so it never goes stale.
refresh_helpers() {
  HELPER_REF=$(installer_ref)
  log "Refreshing helper scripts (ref $HELPER_REF)"
  refresh_helper launch.sh || true
  if [ "$OS" = Linux ]; then
    refresh_helper kiosk_session.py || true
  fi
  if refresh_helper hostnet.sh; then
    run_hostnet_limited || true
  fi
  return 0
}

update_image() {
  local rc
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

run_update() {
  local rc
  log "---- update.sh ----"
  update_image; rc=$?
  # The helpers come after the image step on purpose: installer_ref reads the
  # revision label of the image running once the update, rollback, recovery
  # or skip has settled, so the scripts match the app the laptop now runs
  # (not the one it ran before, nor one that was just rolled back).
  refresh_helpers || true
  return "$rc"
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
