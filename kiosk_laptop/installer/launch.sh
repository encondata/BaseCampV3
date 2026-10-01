#!/usr/bin/env bash
# ServerSherpa kiosk launcher (laptop edition), macOS and Linux.
#
# Run at sign-in (macOS launch agent com.serversherpa.kiosk.launch, Linux
# autostart serversherpa-kiosk.desktop) and from the ServerSherpa Kiosk app
# or menu entry. Waits for the kiosk to answer, then opens it in the browser
# the installer found (KIOSK_BROWSER in config.env), in app mode.
#
# Environment: KIOSK_LAUNCH_TIMEOUT_S (default 300), KIOSK_LAUNCH_POLL_S (2).
# Testing hooks: KIOSK_LAUNCH_LIB=1 defines the functions without running main.
# Written for bash 3.2 (macOS's bash).
set -uo pipefail

KIOSK_DIR="${KIOSK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
KIOSK_URL='http://localhost:8090'
KIOSK_LAUNCH_TIMEOUT_S="${KIOSK_LAUNCH_TIMEOUT_S:-300}"
KIOSK_LAUNCH_POLL_S="${KIOSK_LAUNCH_POLL_S:-2}"
OS=$(uname -s)

kiosk_answers() { curl -fsS --max-time 3 "$KIOSK_URL/edge/identity" >/dev/null 2>&1; }

# wait_for_kiosk: until /edge/identity answers or the timeout passes.
wait_for_kiosk() {
  local deadline=$((SECONDS + KIOSK_LAUNCH_TIMEOUT_S))
  until kiosk_answers; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "The kiosk didn't answer at $KIOSK_URL within $KIOSK_LAUNCH_TIMEOUT_S seconds; opening it anyway." >&2
      return 1
    fi
    sleep "$KIOSK_LAUNCH_POLL_S"
  done
}

# browser: KIOSK_BROWSER from config.env, read without executing the file.
browser() {
  local line=''
  [ -f "$KIOSK_DIR/config.env" ] || return 0
  line=$(grep -E '^KIOSK_BROWSER=' "$KIOSK_DIR/config.env" | head -n 1 || true)
  printf '%s' "${line#*=}"
}

run_browser() { "$@" >/dev/null 2>&1 & }

open_kiosk() {
  local b
  b=$(browser)
  if [ "$OS" = Darwin ]; then
    if [ -n "$b" ]; then
      open -na "$b" --args --app="$KIOSK_URL"
    else
      open "$KIOSK_URL"
    fi
  elif [ -n "$b" ]; then
    run_browser "$b" --app="$KIOSK_URL"
  else
    xdg-open "$KIOSK_URL"
  fi
}

main() {
  wait_for_kiosk || true
  open_kiosk
}

# Called on the last line so a partially written script runs nothing.
if [ "${KIOSK_LAUNCH_LIB:-0}" != "1" ]; then
  main "$@"
fi
