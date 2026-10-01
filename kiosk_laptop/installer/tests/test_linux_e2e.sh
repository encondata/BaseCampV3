#!/usr/bin/env bash
# End-to-end run of the Linux installer and nightly updater against a real
# Docker engine and systemd. CI runs it on a GitHub ubuntu runner (as a user
# with passwordless sudo) after the image is built:
#
#   kiosk_laptop/installer/tests/test_linux_e2e.sh kiosk-laptop:ci
#
# It installs the kiosk system-wide (/opt/serversherpa-kiosk, data in
# /var/lib/serversherpa-kiosk) and finally deletes that data folder, so it
# refuses to run outside CI unless KIOSK_E2E_OK=1.
#
# The installer and updater always `docker compose pull`, so the image is
# served from a throwaway local registry (localhost:5000) instead of a
# local-only tag that pull can't find. No real cloud: --api-url points at a
# closed port.
#
# Checks, in order (exits non-zero with a message on the first failure):
#   1. install: exit 0, kiosk-laptop-* serial, laptop config.js, timer enabled
#   2. re-install: same serial
#   3. update with an unchanged image: exit 0, container not recreated
#   3b. update to a newer good image: exit 0, running it, :previous = the old
#      one, same serial, phase done
#   4. update to a broken image: exit 1, rolled back to the (3b) image and
#      healthy; the next run skips the rejected image and exits 0; a
#      re-install keeps the running image too (warns, no recreate)
#   5. uninstall keeps the data folder; uninstall --purge-data (DELETE typed
#      on the KIOSK_TTY file) deletes it
set -euo pipefail

SRC_IMAGE="${1:-}"
[ -n "$SRC_IMAGE" ] || { echo "usage: $0 IMAGE" >&2; exit 2; }
if [ -z "${CI:-}" ] && [ "${KIOSK_E2E_OK:-}" != 1 ]; then
  echo "This test installs the kiosk system-wide and deletes its data folder." >&2
  echo "It runs in CI; set KIOSK_E2E_OK=1 to run it on a disposable machine." >&2
  exit 2
fi
[ "$(uname -s)" = Linux ] || { echo "Linux only." >&2; exit 2; }

cd "$(dirname "$0")/../../.."
REPO=$PWD
INSTALLER_DIR="$REPO/kiosk_laptop/installer"
REG_PORT="${KIOSK_E2E_REGISTRY_PORT:-5000}"
REG_NAME=kiosk-e2e-registry
IMAGE="localhost:$REG_PORT/serversherpa-kiosk-laptop:e2e"
# A builder that reads and writes the local image store: the docker-driver
# builder named after the current context (setup-buildx-action makes a
# docker-container builder the default, which does neither).
BUILDER="${KIOSK_E2E_BUILDER:-$(docker context show 2>/dev/null || echo default)}"
INSTALL_DIR=/opt/serversherpa-kiosk
DATA_DIR=/var/lib/serversherpa-kiosk
CONTAINER=serversherpa-kiosk-edge-1
TIMER=serversherpa-kiosk-update.timer
EDGE=http://127.0.0.1:8090

step() { printf '\n==== %s\n' "$*"; }
pass() { printf 'ok: %s\n' "$*"; }

diagnostics() {
  echo "---- docker ps -a"
  docker ps -a || true
  echo "---- docker logs $CONTAINER (last 40 lines)"
  docker logs --tail 40 "$CONTAINER" 2>&1 || true
  echo "---- $INSTALL_DIR/install.log (last 40 lines)"
  sudo tail -n 40 "$INSTALL_DIR/install.log" 2>/dev/null || true
  echo "---- $INSTALL_DIR/update.log (last 40 lines)"
  sudo tail -n 40 "$INSTALL_DIR/update.log" 2>/dev/null || true
  echo "---- $INSTALL_DIR/update-state.json"
  sudo cat "$INSTALL_DIR/update-state.json" 2>/dev/null || true
}

fail() {
  printf '\nFAIL: %s\n\n' "$*" >&2
  diagnostics >&2
  exit 1
}

TTY_FILE=''

cleanup() {
  docker rm -f "$REG_NAME" >/dev/null 2>&1 || true
  [ -z "$TTY_FILE" ] || rm -f "$TTY_FILE"
}
trap cleanup EXIT

install_kiosk() {
  sudo env KIOSK_IMAGE="$IMAGE" KIOSK_TEMPLATE_DIR="$INSTALLER_DIR" KIOSK_NONINTERACTIVE=1 \
    bash "$INSTALLER_DIR/install.sh" --api-url http://127.0.0.1:9 --yes
}

run_update() {  # run_update [VAR=value...]: update.sh as the systemd service runs it (root)
  sudo env "$@" "$INSTALL_DIR/update.sh"
}

serial() {
  curl -fsS --max-time 5 "$EDGE/edge/identity" | sed -n 's/.*"serial"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

container_field() { docker inspect -f "$1" "$CONTAINER" 2>/dev/null || true; }

wait_healthy() {  # wait_healthy SECONDS
  local deadline=$((SECONDS + $1)) status=''
  while [ "$SECONDS" -lt "$deadline" ]; do
    status=$(container_field '{{.State.Health.Status}}')
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  echo "health is ${status:-unknown}" >&2
  return 1
}

# Stop (not disable) the timer, so a run that spans 03:00 can't race this
# test's own update.sh calls. install.sh starts it again (enable --now), so
# this follows every install. Later steps only check is-enabled.
stop_timer() { sudo systemctl stop "$TIMER" || fail "couldn't stop $TIMER"; }

update_log() { sudo cat "$INSTALL_DIR/update.log" 2>/dev/null || true; }
state_value() {
  sudo sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$INSTALL_DIR/update-state.json" 2>/dev/null | head -n 1
}

# ── Registry with the image under test ────────────────────────────────
step "Serving $SRC_IMAGE as $IMAGE from a local registry"
docker image inspect "$SRC_IMAGE" >/dev/null 2>&1 || fail "image $SRC_IMAGE isn't in the local image store"
docker rm -f "$REG_NAME" >/dev/null 2>&1 || true
docker run -d --name "$REG_NAME" -p "127.0.0.1:$REG_PORT:5000" registry:2 >/dev/null \
  || fail "couldn't start the local registry"
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$REG_PORT/v2/" >/dev/null && break; sleep 1; done
curl -fs "http://127.0.0.1:$REG_PORT/v2/" >/dev/null || fail "the local registry didn't answer"
docker tag "$SRC_IMAGE" "$IMAGE"
docker push -q "$IMAGE" >/dev/null || fail "couldn't push $IMAGE"
pass "registry up, image pushed"

# ── 1. Install ────────────────────────────────────────────────────────
step "1. Install"
rc=0; install_kiosk || rc=$?
[ "$rc" = 0 ] || fail "install.sh exited $rc"
SERIAL=$(serial || true)
case "$SERIAL" in kiosk-laptop-*) pass "serial $SERIAL" ;; *) fail "identity serial is '${SERIAL}'" ;; esac
curl -fsS --max-time 5 "$EDGE/config.js" | grep -q '"mode": "laptop"' || fail "config.js doesn't say laptop mode"
pass "config.js says laptop"
systemctl is-enabled "$TIMER" >/dev/null 2>&1 || fail "$TIMER isn't enabled"
pass "$TIMER enabled"
[ "$(container_field '{{.State.Health.Status}}')" = healthy ] || fail "container isn't healthy after install"
sudo grep -qx "EDGE_CLOUD_API_URL=http://127.0.0.1:9" "$INSTALL_DIR/config.env" || fail "config.env has the wrong API URL"
[ -f "$HOME/.config/autostart/serversherpa-kiosk.desktop" ] || fail "autostart entry missing for $(id -un)"
pass "container healthy, config.env and autostart entry written"
stop_timer

# ── 2. Re-install is idempotent ───────────────────────────────────────
step "2. Re-install"
rc=0; install_kiosk || rc=$?
[ "$rc" = 0 ] || fail "second install.sh exited $rc"
AGAIN=$(serial || true)
[ "$AGAIN" = "$SERIAL" ] || fail "serial changed on re-install ($SERIAL -> $AGAIN)"
pass "same serial"
systemctl is-enabled "$TIMER" >/dev/null 2>&1 || fail "$TIMER isn't enabled after re-install"
stop_timer

# ── 3. Update with an unchanged image ─────────────────────────────────
step "3. Update, image unchanged"
CREATED=$(container_field '{{.Created}}')
GOOD_IMAGE=$(container_field '{{.Image}}')
[ -n "$GOOD_IMAGE" ] || fail "no running kiosk container"
rc=0; run_update || rc=$?
[ "$rc" = 0 ] || fail "update.sh exited $rc with an unchanged image"
[ "$(container_field '{{.Created}}')" = "$CREATED" ] || fail "container was recreated by a no-op update"
update_log | grep -q 'Already up to date' || fail "update.log doesn't say 'Already up to date'"
pass "exit 0, container not recreated"

# ── 3b. Update to a newer good image ──────────────────────────────────
step "3b. Update to a newer image"
OLD_IMAGE="$GOOD_IMAGE"
printf 'FROM %s\nLABEL e2e.rev=2\n' "$IMAGE" \
  | docker buildx build --builder "$BUILDER" --load -q -t "$IMAGE" - >/dev/null \
  || fail "couldn't build the newer image"
NEW_IMAGE=$(docker image inspect -f '{{.Id}}' "$IMAGE")
[ "$NEW_IMAGE" != "$OLD_IMAGE" ] || fail "the newer image has the old image's ID"
docker push -q "$IMAGE" >/dev/null || fail "couldn't push the newer image"
rc=0; run_update HEALTH_TIMEOUT_S=150 HEALTH_POLL_S=2 || rc=$?
[ "$rc" = 0 ] || fail "update.sh exited $rc on a newer good image (expected 0)"
[ "$(container_field '{{.Image}}')" = "$NEW_IMAGE" ] || fail "container isn't running the newer image $NEW_IMAGE"
[ -n "$OLD_IMAGE" ] || fail "no old image ID recorded before the update"
docker image inspect serversherpa-kiosk-laptop:previous >/dev/null 2>&1 \
  || fail "serversherpa-kiosk-laptop:previous doesn't exist after the update"
[ "$(docker image inspect -f '{{.Id}}' serversherpa-kiosk-laptop:previous 2>/dev/null || true)" = "$OLD_IMAGE" ] \
  || fail "serversherpa-kiosk-laptop:previous isn't the old image $OLD_IMAGE"
! update_log | grep -q "Couldn't tag the previous image" || fail "update.log says the previous image couldn't be tagged"
[ "$(serial || true)" = "$SERIAL" ] || fail "serial changed across the update"
[ "$(state_value phase)" = "done" ] || fail "update-state.json phase isn't done after the update"
update_log | grep -qF "updated to $NEW_IMAGE" || fail "update.log doesn't say 'updated to $NEW_IMAGE'"
GOOD_IMAGE="$NEW_IMAGE"
pass "exit 0, running the newer image, :previous kept, same serial"

# ── 4. Rollback from a broken image ───────────────────────────────────
step "4. Update to a broken image, then roll back"
printf 'FROM %s\nHEALTHCHECK --interval=5s --timeout=3s --retries=1 CMD exit 1\n' "$IMAGE" \
  | docker buildx build --builder "$BUILDER" --load -q -t "$IMAGE" - >/dev/null \
  || fail "couldn't build the broken image"
BROKEN_IMAGE=$(docker image inspect -f '{{.Id}}' "$IMAGE")
[ "$BROKEN_IMAGE" != "$GOOD_IMAGE" ] || fail "the broken image has the good image's ID"
docker push -q "$IMAGE" >/dev/null || fail "couldn't push the broken image"
rc=0; run_update HEALTH_TIMEOUT_S=20 HEALTH_POLL_S=2 || rc=$?
[ "$rc" = 1 ] || fail "update.sh exited $rc on a broken image (expected 1, rolled back)"
update_log | grep -q 'rolled back' || fail "update.log doesn't say 'rolled back'"
[ "$(container_field '{{.Image}}')" = "$GOOD_IMAGE" ] || fail "container isn't back on the old image $GOOD_IMAGE"
wait_healthy 150 || fail "container didn't get healthy again after the rollback"
[ "$(state_value rejected_image)" = "$BROKEN_IMAGE" ] || fail "update-state.json doesn't reject $BROKEN_IMAGE"
[ "$(state_value phase)" = "done" ] || fail "update-state.json phase isn't done"
docker image inspect serversherpa-kiosk-laptop:previous >/dev/null 2>&1 || fail "serversherpa-kiosk-laptop:previous tag missing"
[ "$(serial || true)" = "$SERIAL" ] || fail "serial changed across the rollback"
pass "exit 1, rolled back, healthy on the old image, broken image rejected"

step "4b. Next update skips the rejected image"
CREATED=$(container_field '{{.Created}}')
rc=0; run_update HEALTH_TIMEOUT_S=20 HEALTH_POLL_S=2 || rc=$?
[ "$rc" = 0 ] || fail "update.sh exited $rc on the already-rejected image (expected 0)"
update_log | grep -q "skipping $BROKEN_IMAGE" || fail "update.log doesn't say it skipped $BROKEN_IMAGE"
[ "$(container_field '{{.Created}}')" = "$CREATED" ] || fail "container was recreated while skipping the rejected image"
[ "$(container_field '{{.Image}}')" = "$GOOD_IMAGE" ] || fail "container left the old image"
[ "$(docker image inspect -f '{{.Id}}' "$IMAGE")" = "$GOOD_IMAGE" ] || fail "the channel tag wasn't pointed back at the running image"
pass "exit 0, rejected image skipped, container untouched"

step "4c. Re-install keeps the rejected image off too"
CREATED=$(container_field '{{.Created}}')
REJECTED=$(state_value rejected_image)
rc=0; OUT=$(install_kiosk 2>&1) || rc=$?
printf '%s\n' "$OUT" | tail -n 20
[ "$rc" = 0 ] || fail "install.sh exited $rc on a re-install with the rejected image published"
printf '%s\n' "$OUT" | grep -q "failed its health check on this laptop before" \
  || fail "install.sh didn't warn that the newest version failed its health check before"
[ "$(container_field '{{.Created}}')" = "$CREATED" ] || fail "the re-install recreated the container"
[ "$(container_field '{{.Image}}')" = "$GOOD_IMAGE" ] || fail "the re-install left the good image $GOOD_IMAGE"
[ "$(state_value rejected_image)" = "$REJECTED" ] || fail "the re-install changed rejected_image ($REJECTED -> $(state_value rejected_image))"
stop_timer
pass "exit 0, warned, container untouched, rejected_image unchanged"

# ── 5. Uninstall, then purge ──────────────────────────────────────────
step "5. Uninstall (data kept)"
rc=0; sudo env KIOSK_TEMPLATE_DIR="$INSTALLER_DIR" KIOSK_NONINTERACTIVE=1 \
  bash "$INSTALLER_DIR/install.sh" --uninstall || rc=$?
[ "$rc" = 0 ] || fail "install.sh --uninstall exited $rc"
sudo test -f "$DATA_DIR/identity.json" || fail "$DATA_DIR/identity.json is gone after a plain uninstall"
! systemctl is-enabled "$TIMER" >/dev/null 2>&1 || fail "$TIMER is still enabled"
[ ! -e "/etc/systemd/system/$TIMER" ] || fail "/etc/systemd/system/$TIMER is still there"
! docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "container $CONTAINER is still there"
[ ! -e "$INSTALL_DIR/docker-compose.yml" ] || fail "$INSTALL_DIR/docker-compose.yml is still there"
[ ! -e "$HOME/.config/autostart/serversherpa-kiosk.desktop" ] || fail "autostart entry is still there"
pass "kiosk removed, identity.json kept, timer gone"

step "5b. Uninstall --purge-data"
# The confirmation is typed on the "terminal": KIOSK_TTY is a file holding DELETE.
TTY_FILE=$(mktemp "${TMPDIR:-/tmp}/kiosk-e2e-tty.XXXXXX")
printf 'DELETE\n' >"$TTY_FILE"
rc=0; sudo env KIOSK_TEMPLATE_DIR="$INSTALLER_DIR" KIOSK_NONINTERACTIVE=0 KIOSK_TTY="$TTY_FILE" \
  bash "$INSTALLER_DIR/install.sh" --uninstall --purge-data || rc=$?
[ "$rc" = 0 ] || fail "install.sh --uninstall --purge-data exited $rc"
! sudo test -e "$DATA_DIR" || fail "$DATA_DIR still exists after --purge-data"
pass "data folder deleted"

printf '\nlinux e2e OK (%s)\n' "$SERIAL"
